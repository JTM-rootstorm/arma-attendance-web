import type { FastifyBaseLogger } from "fastify";

import { withDbTransaction } from "../db/transactions.js";

export const STALE_STARTED_OPERATION_HOURS = 6;
const STALE_OPERATION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

type DeletedOperationSummary = {
  id: string;
  server_key: string;
  mission_uid: string | null;
  mission_name: string | null;
  started_at: Date;
};

type StaleCleanupRow = {
  deleted_operations: DeletedOperationSummary[];
  deleted_operation_count: number;
  deleted_ingest_request_count: number;
};

export type StaleOperationCleanupResult = {
  deleted_operation_count: number;
  deleted_ingest_request_count: number;
};

export async function cleanupStaleStartedOperations(): Promise<StaleOperationCleanupResult> {
  return withDbTransaction(async (tx) => {
    const cleanupResult = await tx.query<StaleCleanupRow>(
      `
      WITH stale_operations AS (
        SELECT id, server_key, mission_uid, mission_name, started_at
        FROM operations
        WHERE status = 'started'
          AND started_at < now() - ($1::int * interval '1 hour')
          AND NOT EXISTS (
            SELECT 1
            FROM operation_payloads op
            WHERE op.operation_id = operations.id
              AND op.kind = 'finish'
          )
        FOR UPDATE SKIP LOCKED
      ),
      deleted_ingest_requests AS (
        DELETE FROM ingest_requests ir
        USING stale_operations stale
        WHERE ir.operation_id = stale.id
        RETURNING ir.request_id
      ),
      deleted_operations AS (
        DELETE FROM operations o
        USING stale_operations stale
        WHERE o.id = stale.id
        RETURNING stale.id, stale.server_key, stale.mission_uid, stale.mission_name, stale.started_at
      )
      SELECT
        COALESCE(jsonb_agg(to_jsonb(deleted_operations) ORDER BY deleted_operations.started_at), '[]'::jsonb) AS deleted_operations,
        COUNT(deleted_operations.id)::int AS deleted_operation_count,
        (SELECT COUNT(*)::int FROM deleted_ingest_requests) AS deleted_ingest_request_count
      FROM deleted_operations
      `,
      [STALE_STARTED_OPERATION_HOURS]
    );

    const result = cleanupResult.rows[0] ?? {
      deleted_operations: [],
      deleted_operation_count: 0,
      deleted_ingest_request_count: 0
    };

    if (result.deleted_operation_count > 0) {
      await tx.query(
        `
        INSERT INTO admin_audit_events (actor_label, action, details)
        VALUES ('system', 'cleanup_stale_started_operations', $1::jsonb)
        `,
        [
          JSON.stringify({
            stale_after_hours: STALE_STARTED_OPERATION_HOURS,
            deleted_operation_count: result.deleted_operation_count,
            deleted_ingest_request_count: result.deleted_ingest_request_count,
            operations: result.deleted_operations
          })
        ]
      );
    }

    return {
      deleted_operation_count: result.deleted_operation_count,
      deleted_ingest_request_count: result.deleted_ingest_request_count
    };
  });
}

export function scheduleStaleOperationCleanup(logger: FastifyBaseLogger): () => void {
  let cleanupInProgress = false;

  const runCleanup = async () => {
    if (cleanupInProgress) {
      return;
    }

    cleanupInProgress = true;

    try {
      const result = await cleanupStaleStartedOperations();

      if (result.deleted_operation_count > 0) {
        logger.info(
          {
            staleAfterHours: STALE_STARTED_OPERATION_HOURS,
            deletedOperationCount: result.deleted_operation_count,
            deletedIngestRequestCount: result.deleted_ingest_request_count
          },
          "Cleaned up stale started operations"
        );
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to clean up stale started operations");
    } finally {
      cleanupInProgress = false;
    }
  };

  void runCleanup();

  const interval = setInterval(() => {
    void runCleanup();
  }, STALE_OPERATION_CLEANUP_INTERVAL_MS);

  interval.unref();

  return () => {
    clearInterval(interval);
  };
}
