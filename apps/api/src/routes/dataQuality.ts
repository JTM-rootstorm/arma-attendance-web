import type { FastifyInstance, FastifyReply } from "fastify";

import { canSeeSensitiveIds, deny, getAuthContext } from "../auth/authorization.js";
import { config } from "../config.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { mapWithConcurrency } from "../utils/concurrency.js";

type OperationIssueRow = {
  operation_id: string;
  server_key: string;
  mission_uid: string | null;
  mission_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  payload_count?: number;
  normalized_player_count?: number;
};

type PayloadIssueRow = {
  payload_id: string;
  operation_id: string | null;
  request_id: string;
  kind: "start" | "finish";
  received_at: Date;
};

type PlayerIssueRow = {
  player_uid: string;
  first_seen_at: Date;
  last_seen_at: Date;
};

type StatsIssueRow = {
  operation_id: string;
  player_uid: string;
};

type PlaceholderRosterIssueRow = {
  unit_id: string;
  placeholder_uid: string;
  canonical_player_uid: string;
  discord_user_id: string;
};

type FinishedOperationUnitIssueRow = {
  operation_id: string;
  server_key: string;
  started_at: Date;
  ended_at: Date | null;
};

type DataQualityChecks = {
  started_operations_without_finish: OperationIssueRow[];
  finished_operations_without_end_payload: OperationIssueRow[];
  operations_without_normalized_players: OperationIssueRow[];
  operation_payloads_without_operation: PayloadIssueRow[];
  players_without_names: PlayerIssueRow[];
  stats_without_attendance: StatsIssueRow[];
  placeholder_roster_rows_with_canonical_links: PlaceholderRosterIssueRow[];
  stats_without_canonical_unit_roster: StatsIssueRow[];
  finished_operations_with_stats_without_operation_units: FinishedOperationUnitIssueRow[];
};

type DataQualityTask<Key extends keyof DataQualityChecks = keyof DataQualityChecks> = {
  key: Key;
  run: () => Promise<DataQualityChecks[Key]>;
};

function sendDatabaseUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: {
      code: "database_unavailable",
      message: "Database is not available."
    }
  });
}

export async function registerDataQualityRoutes(app: FastifyInstance) {
  app.get("/v1/data-quality", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { allowMachineToken: true });

    if (!auth) {
      return;
    }

    if (auth.user && !canSeeSensitiveIds(auth.user)) {
      return deny(reply);
    }

    try {
      const tasks: DataQualityTask[] = [
        {
          key: "started_operations_without_finish",
          run: async () =>
            (
              await queryDb<OperationIssueRow>(
                `
                SELECT
                  id AS operation_id,
                  server_key,
                  mission_uid,
                  mission_name,
                  started_at,
                  ended_at
                FROM operations
                WHERE status = 'started'
                  AND ended_at IS NULL
                ORDER BY started_at DESC
                LIMIT 25
                `
              )
            ).rows
        },
        {
          key: "finished_operations_without_end_payload",
          run: async () =>
            (
              await queryDb<OperationIssueRow>(
                `
                SELECT
                  id AS operation_id,
                  server_key,
                  mission_uid,
                  mission_name,
                  started_at,
                  ended_at
                FROM operations
                WHERE status = 'finished'
                  AND raw_end_payload IS NULL
                ORDER BY started_at DESC
                LIMIT 25
                `
              )
            ).rows
        },
        {
          key: "operations_without_normalized_players",
          run: async () =>
            (
              await queryDb<OperationIssueRow>(
                `
                SELECT
                  o.id AS operation_id,
                  o.server_key,
                  o.mission_uid,
                  o.mission_name,
                  o.started_at,
                  o.ended_at,
                  COUNT(op.player_uid)::int AS normalized_player_count
                FROM operations o
                LEFT JOIN operation_players op ON op.operation_id = o.id
                GROUP BY o.id
                HAVING COUNT(op.player_uid) = 0
                ORDER BY o.started_at DESC
                LIMIT 25
                `
              )
            ).rows
        },
        {
          key: "operation_payloads_without_operation",
          run: async () =>
            (
              await queryDb<PayloadIssueRow>(
                `
                SELECT
                  op.id AS payload_id,
                  op.operation_id,
                  op.request_id,
                  op.kind,
                  op.received_at
                FROM operation_payloads op
                LEFT JOIN operations o ON o.id = op.operation_id
                WHERE o.id IS NULL
                ORDER BY op.received_at DESC
                LIMIT 25
                `
              )
            ).rows
        },
        {
          key: "players_without_names",
          run: async () =>
            (
              await queryDb<PlayerIssueRow>(
                `
                SELECT player_uid, first_seen_at, last_seen_at
                FROM players
                WHERE deleted_at IS NULL
                  AND (last_name IS NULL OR btrim(last_name) = '')
                ORDER BY last_seen_at DESC
                LIMIT 25
                `
              )
            ).rows
        },
        {
          key: "stats_without_attendance",
          run: async () =>
            (
              await queryDb<StatsIssueRow>(
                `
                SELECT ops.operation_id, ops.player_uid
                FROM operation_player_stats ops
                LEFT JOIN operation_players op
                  ON op.operation_id = ops.operation_id
                  AND op.player_uid = ops.player_uid
                WHERE op.player_uid IS NULL
                ORDER BY ops.operation_id, ops.player_uid
                LIMIT 25
                `
              )
            ).rows
        },
        {
          key: "placeholder_roster_rows_with_canonical_links",
          run: async () =>
            (
              await queryDb<PlaceholderRosterIssueRow>(
                `
                SELECT
                  up.unit_id,
                  up.player_uid AS placeholder_uid,
                  pdl.player_uid AS canonical_player_uid,
                  pdl.discord_user_id
                FROM unit_players up
                JOIN player_discord_links pdl
                  ON up.player_uid = ('discord:' || pdl.discord_user_id)
                WHERE pdl.player_uid <> up.player_uid
                ORDER BY up.unit_id, up.player_uid
                LIMIT 25
                `
              )
            ).rows
        },
        {
          key: "stats_without_canonical_unit_roster",
          run: async () =>
            (
              await queryDb<StatsIssueRow>(
                `
                WITH canonical_unit_players AS (
                  SELECT DISTINCT
                    up.unit_id,
                    COALESCE(
                      CASE
                        WHEN pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
                        ELSE NULL
                      END,
                      up.player_uid
                    ) AS player_uid
                  FROM unit_players up
                  LEFT JOIN player_discord_links pdl
                    ON up.player_uid = ('discord:' || pdl.discord_user_id)
                )
                SELECT ops.operation_id, ops.player_uid
                FROM operation_player_stats ops
                LEFT JOIN canonical_unit_players cup ON cup.player_uid = ops.player_uid
                WHERE cup.player_uid IS NULL
                ORDER BY ops.operation_id, ops.player_uid
                LIMIT 25
                `
              )
            ).rows
        },
        {
          key: "finished_operations_with_stats_without_operation_units",
          run: async () =>
            (
              await queryDb<FinishedOperationUnitIssueRow>(
                `
                SELECT o.id AS operation_id, o.server_key, o.started_at, o.ended_at
                FROM operations o
                WHERE o.status = 'finished'
                  AND EXISTS (
                    SELECT 1 FROM operation_player_stats ops WHERE ops.operation_id = o.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM operation_units ou WHERE ou.operation_id = o.id
                  )
                ORDER BY o.started_at DESC
                LIMIT 25
                `
              )
            ).rows
        }
      ];
      const entries = await mapWithConcurrency(tasks, config.asyncDbReadConcurrency, async (task) => [task.key, await task.run()] as const);
      const checks = Object.fromEntries(entries) as DataQualityChecks;

      return { ok: true, checks };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch data quality checks");
      return sendDatabaseUnavailable(reply);
    }
  });
}
