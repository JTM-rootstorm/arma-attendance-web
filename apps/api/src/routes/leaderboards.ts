import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { canSeeSensitiveIds, getOptionalAuthContext } from "../auth/authorization.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";

const unitLeaderboardQuerySchema = z.object({
  unit_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  lookback_days: z.coerce.number().int().min(1).max(3650).optional(),
  min_operations: z.coerce.number().int().min(0).default(0),
  metric: z.enum(["total_kills"]).default("total_kills")
});

type UnitLeaderboardRow = {
  rank: number;
  unit_id: string;
  unit_key: string;
  name: string;
  member_count: number;
  operation_count: number;
  infantry_kills: number;
  soft_vehicle_kills: number;
  armor_kills: number;
  air_kills: number;
  deaths: number;
  total_kills: number;
};

function sendValidationFailed(reply: FastifyReply) {
  return reply.code(400).send({
    ok: false,
    error: {
      code: "validation_failed",
      message: "Request did not match expected shape."
    }
  });
}

function sendDatabaseUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: {
      code: "database_unavailable",
      message: "Database is not available."
    }
  });
}

export async function registerLeaderboardRoutes(app: FastifyInstance) {
  app.get("/v1/leaderboard/units", async (request, reply) => {
    const auth = await getOptionalAuthContext(request, {
      machineTokenKinds: ["api", "arma_server", "base44_integration"]
    });

    const parsed = unitLeaderboardQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const query = parsed.data;
    const values: unknown[] = [];
    const filters = ["u.is_active = true", "u.deleted_at IS NULL"];
    const operationJoinFilters = ["ops.operation_id = o.id"];

    if (query.unit_id) {
      values.push(query.unit_id);
      filters.push(`u.id = $${values.length}`);
    }

    if (query.lookback_days) {
      values.push(query.lookback_days);
      operationJoinFilters.push(`o.started_at >= now() - ($${values.length}::int * interval '1 day')`);
    }

    values.push(query.min_operations);
    const minOperationsParam = values.length;
    values.push(query.limit);
    const limitParam = values.length;
    values.push(query.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb<UnitLeaderboardRow>(
        `
        WITH totals AS (
          SELECT
            u.id AS unit_id,
            u.unit_key,
            COALESCE(u.display_name, u.name) AS name,
            COUNT(DISTINCT up.player_uid)::int AS member_count,
            COUNT(DISTINCT o.id)::int AS operation_count,
            COALESCE(SUM(ops.infantry_kills) FILTER (WHERE o.id IS NOT NULL), 0)::int AS infantry_kills,
            COALESCE(SUM(ops.soft_vehicle_kills) FILTER (WHERE o.id IS NOT NULL), 0)::int AS soft_vehicle_kills,
            COALESCE(SUM(ops.armor_kills) FILTER (WHERE o.id IS NOT NULL), 0)::int AS armor_kills,
            COALESCE(SUM(ops.air_kills) FILTER (WHERE o.id IS NOT NULL), 0)::int AS air_kills,
            COALESCE(SUM(ops.deaths) FILTER (WHERE o.id IS NOT NULL), 0)::int AS deaths
          FROM units u
          JOIN unit_players up
            ON up.unit_id = u.id
            AND up.is_active = true
            AND up.roster_status <> 'inactive'
          LEFT JOIN operation_player_stats ops ON ops.player_uid = up.player_uid
          LEFT JOIN operations o ON ${operationJoinFilters.join(" AND ")}
          WHERE ${filters.join(" AND ")}
          GROUP BY u.id
        ),
        ranked AS (
          SELECT
            ROW_NUMBER() OVER (
              ORDER BY
                (infantry_kills + soft_vehicle_kills + armor_kills + air_kills) DESC,
                name ASC
            )::int AS rank,
            *,
            (infantry_kills + soft_vehicle_kills + armor_kills + air_kills)::int AS total_kills
          FROM totals
          WHERE operation_count >= $${minOperationsParam}
        )
        SELECT *
        FROM ranked
        ORDER BY rank ASC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      const revealSensitive = canSeeSensitiveIds(auth.user, auth.machineTokenKind);

      return {
        ok: true,
        leaderboard: result.rows.map((row) => ({
          rank: row.rank,
          unit_id: revealSensitive ? row.unit_id : null,
          unit_key: revealSensitive ? row.unit_key : null,
          name: row.name,
          member_count: row.member_count,
          operation_count: row.operation_count,
          total_kills: row.total_kills,
          infantry_kills: row.infantry_kills,
          soft_vehicle_kills: row.soft_vehicle_kills,
          armor_kills: row.armor_kills,
          air_kills: row.air_kills,
          deaths: row.deaths
        })),
        pagination: { limit: query.limit, offset: query.offset, count: result.rows.length }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to load unit leaderboard");
      return sendDatabaseUnavailable(reply);
    }
  });
}
