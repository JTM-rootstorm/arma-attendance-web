import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { hasRole, type CurrentUser, type MachineTokenKind } from "../auth.js";
import { canSeeSensitiveIds, deny, getAuthContext, getReadableUnitFilter } from "../auth/authorization.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { players } from "../db/schema/players.js";
import { unitPlayers } from "../db/schema/units.js";
import { redactOperationListItem, redactPlayer } from "../privacy/redaction.js";

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
  status: "started" | "finished" | "failed" | "abandoned";
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
  soft_vehicle_kills: number | null;
  armor_kills: number | null;
  air_kills: number | null;
  ground_vehicle_kills: number | null;
  all_vehicle_kills: number | null;
  scoreboard_score: number | null;
};

function canSeeRosterOperationalDetails(user: CurrentUser | null, machineTokenKind?: MachineTokenKind | null): boolean {
  return user === null ? machineTokenKind !== "base44_integration" : hasRole(user, ["admin"]);
}

function canSeePlayerOperationalDetails(user: CurrentUser | null, machineTokenKind?: MachineTokenKind | null): boolean {
  return canSeeRosterOperationalDetails(user, machineTokenKind);
}

function redactPlayerForRoster<T extends PlayerRow>(row: T, revealSensitive: boolean, revealOperationalDetails: boolean) {
  const redacted = redactPlayer(row, revealSensitive);

  return {
    ...redacted,
    operation_count: revealOperationalDetails ? row.operation_count : null
  };
}

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
  app.get("/v1/players", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { machineTokenKinds: ["api", "arma_server", "base44_integration"] });

    if (!auth) {
      return;
    }

    const parsedQuery = playerListQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const query = parsedQuery.data;
    const where: string[] = ["p.deleted_at IS NULL"];
    const values: unknown[] = [];
    const unitFilter = await getReadableUnitFilter(auth.user);
    const revealOperationalDetails = canSeeRosterOperationalDetails(auth.user, auth.machineTokenKind);
    const revealSensitive = canSeeSensitiveIds(auth.user, auth.machineTokenKind) || revealOperationalDetails;

    if (!unitFilter.all) {
      if (unitFilter.unitIds.length === 0) {
        return deny(reply);
      }

      values.push(unitFilter.unitIds);
      where.push(`EXISTS (
        SELECT 1 FROM unit_players up_filter
        WHERE up_filter.player_uid = p.player_uid
          AND up_filter.unit_id = ANY($${values.length}::uuid[])
      )`);
    }

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
        players: playersResult.rows.map((row) => redactPlayerForRoster(row, revealSensitive, revealOperationalDetails)),
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

  app.get("/v1/players/:player_uid", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { allowMachineToken: true });

    if (!auth) {
      return;
    }

    const parsedParams = playerParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { player_uid: playerUid } = parsedParams.data;

    try {
      const [player] = await getDrizzleDb()
        .select({
          player_uid: players.playerUid,
          last_name: players.lastName,
          first_seen_at: players.firstSeenAt,
          last_seen_at: players.lastSeenAt,
          raw_last_player: players.rawLastPlayer,
          created_at: players.createdAt,
          updated_at: players.updatedAt
        })
        .from(players)
        .where(and(eq(players.playerUid, playerUid), isNull(players.deletedAt)))
        .limit(1);

      if (!player) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "player_not_found",
            message: "Player was not found."
          }
        });
      }

      if (auth.user) {
        const steamId = auth.user.identities.find((identity) => identity.provider === "steam")?.provider_user_id;
        const ownsPlayer = steamId === playerUid;

        if (!ownsPlayer) {
          const unitFilter = await getReadableUnitFilter(auth.user);
          const visibleRows = await getDrizzleDb()
            .select({ unit_id: unitPlayers.unitId })
            .from(unitPlayers)
            .where(
              unitFilter.all
                ? eq(unitPlayers.playerUid, playerUid)
                : and(eq(unitPlayers.playerUid, playerUid), inArray(unitPlayers.unitId, unitFilter.unitIds))
            )
            .limit(1);

          if (!visibleRows[0]) {
            return deny(reply);
          }
        }
      }

      const revealOperationalDetails = canSeePlayerOperationalDetails(auth.user, auth.machineTokenKind);
      const revealSensitive = canSeeSensitiveIds(auth.user, auth.machineTokenKind) || revealOperationalDetails;
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
          ops.deaths,
          ops.soft_vehicle_kills,
          ops.armor_kills,
          ops.air_kills,
          ops.ground_vehicle_kills,
          ops.all_vehicle_kills,
          ops.scoreboard_score
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
        player: redactPlayer(player, revealSensitive),
        recent_operations: revealOperationalDetails ? operationsResult.rows.map((row) => redactOperationListItem({
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
                },
          scoreboard_stats:
            row.stats_player_uid === null
              ? null
              : {
                  infantry_kills: row.infantry_kills ?? 0,
                  soft_vehicle_kills: row.soft_vehicle_kills ?? 0,
                  armor_kills: row.armor_kills ?? 0,
                  ground_vehicle_kills: row.ground_vehicle_kills ?? 0,
                  air_kills: row.air_kills ?? 0,
                  all_vehicle_kills: row.all_vehicle_kills ?? 0,
                  deaths: row.deaths ?? 0,
                  score: row.scoreboard_score ?? 0
                }
        }, revealSensitive)) : []
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch player");
      return sendDatabaseUnavailable(reply);
    }
  });
}
