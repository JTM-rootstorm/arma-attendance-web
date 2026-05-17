import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireBearerToken } from "../auth.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";

const playerListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const playerParamsSchema = z.object({
  player_uid: z.string().min(1).max(200)
});

type PlayerRow = {
  player_uid: string;
  last_name: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  raw_last_player: unknown;
  operation_count: number;
};

type PlayerDetailRow = {
  player_uid: string;
  last_name: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  raw_last_player: unknown;
  created_at: Date;
  updated_at: Date;
};

type PlayerOperationRow = {
  operation_id: string;
  server_key: string;
  status: "started" | "finished" | "abandoned";
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  present_at_start: boolean;
  present_at_end: boolean;
  name_at_start: string | null;
  name_at_end: string | null;
  stats_player_uid: string | null;
  infantry_kills: number | null;
  vehicle_kills: number | null;
  player_kills: number | null;
  ai_kills: number | null;
  friendly_kills: number | null;
  deaths: number | null;
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

export async function registerPlayerRoutes(app: FastifyInstance) {
  app.get("/v1/players", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsedQuery = playerListQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const query = parsedQuery.data;
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.q && query.q.trim().length > 0) {
      values.push(`%${query.q.trim()}%`);
      where.push(`(p.player_uid ILIKE $${values.length} OR p.last_name ILIKE $${values.length})`);
    }

    values.push(query.limit);
    const limitParam = values.length;
    values.push(query.offset);
    const offsetParam = values.length;

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    try {
      const playersResult = await queryDb<PlayerRow>(
        `
        SELECT
          p.player_uid,
          p.last_name,
          p.first_seen_at,
          p.last_seen_at,
          p.raw_last_player,
          COUNT(op.operation_id)::int AS operation_count
        FROM players p
        LEFT JOIN operation_players op ON op.player_uid = p.player_uid
        ${whereClause}
        GROUP BY p.player_uid
        ORDER BY p.last_seen_at DESC, p.player_uid
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return {
        ok: true,
        players: playersResult.rows,
        pagination: {
          limit: query.limit,
          offset: query.offset,
          count: playersResult.rows.length
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list players");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/players/:player_uid", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsedParams = playerParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { player_uid: playerUid } = parsedParams.data;

    try {
      const playerResult = await queryDb<PlayerDetailRow>(
        `
        SELECT
          player_uid,
          last_name,
          first_seen_at,
          last_seen_at,
          raw_last_player,
          created_at,
          updated_at
        FROM players
        WHERE player_uid = $1
        `,
        [playerUid]
      );

      const player = playerResult.rows[0];

      if (!player) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "player_not_found",
            message: "Player was not found."
          }
        });
      }

      const operationsResult = await queryDb<PlayerOperationRow>(
        `
        SELECT
          o.id AS operation_id,
          o.server_key,
          o.status,
          o.mission_uid,
          o.mission_name,
          o.world_name,
          o.started_at,
          o.ended_at,
          op.present_at_start,
          op.present_at_end,
          op.name_at_start,
          op.name_at_end,
          ops.player_uid AS stats_player_uid,
          ops.infantry_kills,
          ops.vehicle_kills,
          ops.player_kills,
          ops.ai_kills,
          ops.friendly_kills,
          ops.deaths
        FROM operation_players op
        JOIN operations o ON o.id = op.operation_id
        LEFT JOIN operation_player_stats ops
          ON ops.operation_id = op.operation_id
          AND ops.player_uid = op.player_uid
        WHERE op.player_uid = $1
        ORDER BY o.started_at DESC
        LIMIT 25
        `,
        [playerUid]
      );

      return {
        ok: true,
        player,
        recent_operations: operationsResult.rows.map((row) => ({
          operation_id: row.operation_id,
          server_key: row.server_key,
          status: row.status,
          mission_uid: row.mission_uid,
          mission_name: row.mission_name,
          world_name: row.world_name,
          started_at: row.started_at,
          ended_at: row.ended_at,
          present_at_start: row.present_at_start,
          present_at_end: row.present_at_end,
          name_at_start: row.name_at_start,
          name_at_end: row.name_at_end,
          stats:
            row.stats_player_uid === null
              ? null
              : {
                  infantry_kills: row.infantry_kills ?? 0,
                  vehicle_kills: row.vehicle_kills ?? 0,
                  player_kills: row.player_kills ?? 0,
                  ai_kills: row.ai_kills ?? 0,
                  friendly_kills: row.friendly_kills ?? 0,
                  deaths: row.deaths ?? 0
                }
        }))
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch player");
      return sendDatabaseUnavailable(reply);
    }
  });
}
