import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { canSeeSensitiveIds, deny, getAuthContext, getReadableUnitFilter } from "../auth/authorization.js";
import { requireUnitRead } from "../auth/units.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { redactOperationListItem, redactPlayer } from "../privacy/redaction.js";

const dashboardSummaryQuerySchema = z.object({
  server_key: z.string().max(128).optional(),
  since: z.string().datetime({ offset: true }).optional()
});

const operationParamsSchema = z.object({
  operation_id: z.string().uuid()
});

const playerParamsSchema = z.object({
  player_uid: z.string().min(1).max(200)
});

type DashboardSummaryRow = {
  operations_total: number;
  operations_started: number;
  operations_finished: number;
  players_total: number;
  attendance_rows_total: number;
  stats_rows_total: number;
  last_operation_at: Date | null;
};

type RecentOperationRow = {
  id: string;
  unit_id: string | null;
  server_key: string;
  status: "started" | "finished" | "abandoned";
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  attendance_count: number;
};

type TopPlayerAttendanceRow = {
  player_uid: string;
  last_name: string | null;
  operation_count: number;
};

type TopPlayerKillsRow = {
  player_uid: string;
  last_name: string | null;
  ai_kills: number;
};

type OperationIdentityRow = {
  id: string;
  unit_id: string | null;
  server_key: string;
  status: "started" | "finished" | "abandoned";
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
};

type OperationAttendanceSummaryRow = {
  present_at_start: number;
  present_at_end: number;
  start_only: number;
  end_only: number;
  both_start_and_end: number;
};

type StatsSummaryRow = {
  infantry_kills: number;
  vehicle_kills: number;
  player_kills: number;
  ai_kills: number;
  friendly_kills: number;
  deaths: number;
};

type PayloadSummaryRow = {
  total: number;
  start: number;
  finish: number;
};

type PlayerIdentityRow = {
  player_uid: string;
  last_name: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
};

type PlayerSummaryRow = StatsSummaryRow & {
  operation_count: number;
  present_at_start_count: number;
  present_at_end_count: number;
};

type PlayerRecentOperationRow = {
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

function buildDashboardWhere(
  query: z.infer<typeof dashboardSummaryQuerySchema>,
  unitFilter: { all: boolean; unitIds: string[] }
): {
  whereClause: string;
  values: unknown[];
} {
  const where: string[] = [];
  const values: unknown[] = [];

  if (!unitFilter.all) {
    values.push(unitFilter.unitIds);
    where.push(`unit_id = ANY($${values.length}::uuid[])`);
  }

  if (query.server_key) {
    values.push(query.server_key);
    where.push(`server_key = $${values.length}`);
  }

  if (query.since) {
    values.push(query.since);
    where.push(`started_at >= $${values.length}`);
  }

  return {
    whereClause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    values
  };
}

export async function registerSummaryRoutes(app: FastifyInstance) {
  app.get("/v1/dashboard/summary", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { allowMachineToken: true });

    if (!auth) {
      return;
    }

    const parsedQuery = dashboardSummaryQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const unitFilter = await getReadableUnitFilter(auth.user);

    if (!unitFilter.all && unitFilter.unitIds.length === 0) {
      return {
        ok: true,
        summary: {
          operations_total: 0,
          operations_started: 0,
          operations_finished: 0,
          players_total: 0,
          attendance_rows_total: 0,
          stats_rows_total: 0,
          last_operation_at: null
        },
        recent_operations: [],
        top_players_by_attendance: [],
        top_players_by_ai_kills: []
      };
    }

    const { whereClause, values } = buildDashboardWhere(parsedQuery.data, unitFilter);

    try {
      const summaryResult = await queryDb<DashboardSummaryRow>(
        `
        WITH filtered_operations AS (
          SELECT id, status, started_at
          FROM operations
          ${whereClause}
        )
        SELECT
          COUNT(*)::int AS operations_total,
          COUNT(*) FILTER (WHERE status = 'started')::int AS operations_started,
          COUNT(*) FILTER (WHERE status = 'finished')::int AS operations_finished,
          COUNT(DISTINCT op.player_uid)::int AS players_total,
          COUNT(op.player_uid)::int AS attendance_rows_total,
          COUNT(ops.player_uid)::int AS stats_rows_total,
          MAX(fo.started_at) AS last_operation_at
        FROM filtered_operations fo
        LEFT JOIN operation_players op ON op.operation_id = fo.id
        LEFT JOIN operation_player_stats ops
          ON ops.operation_id = op.operation_id
          AND ops.player_uid = op.player_uid
        `,
        values
      );

      const recentOperationsResult = await queryDb<RecentOperationRow>(
        `
        SELECT
          o.id,
          o.unit_id,
          o.server_key,
          o.status,
          o.mission_uid,
          o.mission_name,
          o.world_name,
          o.started_at,
          o.ended_at,
          COUNT(op.player_uid)::int AS attendance_count
        FROM operations o
        LEFT JOIN operation_players op ON op.operation_id = o.id
        ${whereClause ? whereClause.replaceAll("server_key", "o.server_key").replaceAll("started_at", "o.started_at") : ""}
        GROUP BY o.id
        ORDER BY o.started_at DESC
        LIMIT 10
        `,
        values
      );

      const topAttendanceResult = await queryDb<TopPlayerAttendanceRow>(
        `
        SELECT
          p.player_uid,
          p.last_name,
          COUNT(DISTINCT op.operation_id)::int AS operation_count
        FROM operation_players op
        JOIN operations o ON o.id = op.operation_id
        JOIN players p ON p.player_uid = op.player_uid
        ${whereClause ? whereClause.replaceAll("server_key", "o.server_key").replaceAll("started_at", "o.started_at") : ""}
        GROUP BY p.player_uid
        ORDER BY operation_count DESC, p.last_seen_at DESC, p.player_uid
        LIMIT 10
        `,
        values
      );

      const topKillsResult = await queryDb<TopPlayerKillsRow>(
        `
        SELECT
          p.player_uid,
          p.last_name,
          COALESCE(SUM(ops.ai_kills), 0)::int AS ai_kills
        FROM operation_player_stats ops
        JOIN operations o ON o.id = ops.operation_id
        JOIN players p ON p.player_uid = ops.player_uid
        ${whereClause ? whereClause.replaceAll("server_key", "o.server_key").replaceAll("started_at", "o.started_at") : ""}
        GROUP BY p.player_uid
        ORDER BY ai_kills DESC, p.last_seen_at DESC, p.player_uid
        LIMIT 10
        `,
        values
      );

      return {
        ok: true,
        summary: summaryResult.rows[0] ?? {
          operations_total: 0,
          operations_started: 0,
          operations_finished: 0,
          players_total: 0,
          attendance_rows_total: 0,
          stats_rows_total: 0,
          last_operation_at: null
        },
        recent_operations: recentOperationsResult.rows.map((row) => redactOperationListItem(row, canSeeSensitiveIds(auth.user))),
        top_players_by_attendance: topAttendanceResult.rows.map((row) => redactPlayer(row, canSeeSensitiveIds(auth.user))),
        top_players_by_ai_kills: topKillsResult.rows.map((row) => redactPlayer(row, canSeeSensitiveIds(auth.user)))
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch dashboard summary");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/operations/:operation_id/summary", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { allowMachineToken: true });

    if (!auth) {
      return;
    }

    const parsedParams = operationParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { operation_id: operationId } = parsedParams.data;

    try {
      const operationResult = await queryDb<OperationIdentityRow>(
        `
        SELECT
          id,
          unit_id,
          server_key,
          status,
          mission_uid,
          mission_name,
          world_name,
          started_at,
          ended_at
        FROM operations
        WHERE id = $1
        `,
        [operationId]
      );

      const operation = operationResult.rows[0];

      if (!operation) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "operation_not_found",
            message: "Operation was not found."
          }
        });
      }

      if (auth.user && operation.unit_id && !(await requireUnitRead(auth.user, operation.unit_id, reply))) {
        return;
      }

      const attendanceResult = await queryDb<OperationAttendanceSummaryRow>(
        `
        SELECT
          COUNT(*) FILTER (WHERE present_at_start = true)::int AS present_at_start,
          COUNT(*) FILTER (WHERE present_at_end = true)::int AS present_at_end,
          COUNT(*) FILTER (WHERE present_at_start = true AND present_at_end = false)::int AS start_only,
          COUNT(*) FILTER (WHERE present_at_start = false AND present_at_end = true)::int AS end_only,
          COUNT(*) FILTER (WHERE present_at_start = true AND present_at_end = true)::int AS both_start_and_end
        FROM operation_players
        WHERE operation_id = $1
        `,
        [operationId]
      );

      const statsResult = await queryDb<StatsSummaryRow>(
        `
        SELECT
          COALESCE(SUM(infantry_kills), 0)::int AS infantry_kills,
          COALESCE(SUM(vehicle_kills), 0)::int AS vehicle_kills,
          COALESCE(SUM(player_kills), 0)::int AS player_kills,
          COALESCE(SUM(ai_kills), 0)::int AS ai_kills,
          COALESCE(SUM(friendly_kills), 0)::int AS friendly_kills,
          COALESCE(SUM(deaths), 0)::int AS deaths
        FROM operation_player_stats
        WHERE operation_id = $1
        `,
        [operationId]
      );

      const payloadResult = await queryDb<PayloadSummaryRow>(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE kind = 'start')::int AS start,
          COUNT(*) FILTER (WHERE kind = 'finish')::int AS finish
        FROM operation_payloads
        WHERE operation_id = $1
        `,
        [operationId]
      );

      return {
        ok: true,
        operation_id: operationId,
        operation: redactOperationListItem(operation, canSeeSensitiveIds(auth.user)),
        attendance: attendanceResult.rows[0] ?? {
          present_at_start: 0,
          present_at_end: 0,
          start_only: 0,
          end_only: 0,
          both_start_and_end: 0
        },
        stats: statsResult.rows[0] ?? {
          infantry_kills: 0,
          vehicle_kills: 0,
          player_kills: 0,
          ai_kills: 0,
          friendly_kills: 0,
          deaths: 0
        },
        payloads: payloadResult.rows[0] ?? {
          total: 0,
          start: 0,
          finish: 0
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch operation summary");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/players/:player_uid/summary", async (request, reply) => {
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
      const playerResult = await queryDb<PlayerIdentityRow>(
        `
        SELECT player_uid, last_name, first_seen_at, last_seen_at
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

      if (auth.user) {
        const steamId = auth.user.identities.find((identity) => identity.provider === "steam")?.provider_user_id;
        const ownsPlayer = steamId === playerUid;

        if (!ownsPlayer) {
          const unitFilter = await getReadableUnitFilter(auth.user);
          const visibleResult = unitFilter.all
            ? await queryDb<{ exists: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM unit_players WHERE player_uid = $1) AS exists",
                [playerUid]
              )
            : await queryDb<{ exists: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM unit_players WHERE player_uid = $1 AND unit_id = ANY($2::uuid[])) AS exists",
                [playerUid, unitFilter.unitIds]
              );

          if (!visibleResult.rows[0]?.exists) {
            return deny(reply);
          }
        }
      }

      const summaryResult = await queryDb<PlayerSummaryRow>(
        `
        SELECT
          COUNT(DISTINCT op.operation_id)::int AS operation_count,
          COUNT(*) FILTER (WHERE op.present_at_start = true)::int AS present_at_start_count,
          COUNT(*) FILTER (WHERE op.present_at_end = true)::int AS present_at_end_count,
          COALESCE(SUM(ops.infantry_kills), 0)::int AS infantry_kills,
          COALESCE(SUM(ops.vehicle_kills), 0)::int AS vehicle_kills,
          COALESCE(SUM(ops.player_kills), 0)::int AS player_kills,
          COALESCE(SUM(ops.ai_kills), 0)::int AS ai_kills,
          COALESCE(SUM(ops.friendly_kills), 0)::int AS friendly_kills,
          COALESCE(SUM(ops.deaths), 0)::int AS deaths
        FROM operation_players op
        LEFT JOIN operation_player_stats ops
          ON ops.operation_id = op.operation_id
          AND ops.player_uid = op.player_uid
        WHERE op.player_uid = $1
        `,
        [playerUid]
      );

      const recentOperationsResult = await queryDb<PlayerRecentOperationRow>(
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
          op.present_at_end
        FROM operation_players op
        JOIN operations o ON o.id = op.operation_id
        WHERE op.player_uid = $1
        ORDER BY o.started_at DESC
        LIMIT 10
        `,
        [playerUid]
      );

      return {
        ok: true,
        player_uid: canSeeSensitiveIds(auth.user) ? playerUid : null,
        player: redactPlayer(player, canSeeSensitiveIds(auth.user)),
        summary: summaryResult.rows[0] ?? {
          operation_count: 0,
          present_at_start_count: 0,
          present_at_end_count: 0,
          infantry_kills: 0,
          vehicle_kills: 0,
          player_kills: 0,
          ai_kills: 0,
          friendly_kills: 0,
          deaths: 0
        },
        recent_operations: recentOperationsResult.rows.map((row) => redactOperationListItem(row, canSeeSensitiveIds(auth.user)))
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch player summary");
      return sendDatabaseUnavailable(reply);
    }
  });
}
