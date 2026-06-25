import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";

import { getDefaultUnitId, getUnitIdForServerKey } from "../auth/units.js";
import { config } from "../config.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { type DbTransaction, withDbTransaction } from "../db/transactions.js";
import {
  getMissionField,
  operationFinishBodySchema,
  operationStartBodySchema,
  type OperationFinishBody,
  type OperationStartBody
} from "../routes/operations/schemas.js";
import {
  getExistingIngestResponse,
  insertIngestRequest,
  replayResponse,
  updateIngestRequestResponse
} from "./ingestRequests.js";
import { completeQueuedFinishOperationIngest, completeQueuedStartOperationIngest } from "./operationIngest.js";
import { OperationRouteError, type OperationIngestResponse, type OperationOutcome, type OperationStatus } from "./types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";

type OperationIngestJobKind = "start" | "finish";
type OperationIngestJobStatus = "pending" | "processing" | "completed" | "failed";

type EnqueueResult = {
  requestId: string;
  response: unknown;
  enqueued: boolean;
};

type OperationIngestJob = {
  id: string;
  request_id: string;
  operation_id: string;
  kind: OperationIngestJobKind;
  payload: unknown;
  attempt_count: number;
};

const workerId = randomUUID();
let drainPromise: Promise<void> | null = null;

function statusForFinishOutcome(outcome: OperationOutcome): Extract<OperationStatus, "finished" | "failed"> {
  return outcome === "failed" ? "failed" : "finished";
}

function queuedFailureResponse(code: string, message: string) {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}

async function getFinishOperation(
  tx: DbTransaction,
  operationId: string
): Promise<{ id: string; server_key: string } | undefined> {
  const result = await tx.query<{ id: string; server_key: string }>(
    `
    SELECT id, server_key
    FROM operations
    WHERE id = $1
    `,
    [operationId]
  );

  return result.rows[0];
}

async function insertOperationIngestJob(
  tx: DbTransaction,
  requestId: string,
  operationId: string,
  endpoint: string,
  kind: OperationIngestJobKind,
  payload: unknown
): Promise<void> {
  await tx.query(
    `
    INSERT INTO operation_ingest_jobs (
      request_id,
      operation_id,
      endpoint,
      kind,
      payload
    )
    VALUES ($1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (request_id) DO NOTHING
    `,
    [requestId, operationId, endpoint, kind, JSON.stringify(payload)]
  );
}

export async function enqueueStartOperationIngest(payload: OperationStartBody): Promise<EnqueueResult> {
  return withDbTransaction(async (tx) => {
    const existingResponse = await getExistingIngestResponse(tx, payload.request_id);

    if (existingResponse) {
      return {
        requestId: payload.request_id,
        response: replayResponse(existingResponse),
        enqueued: false
      };
    }

    const unitId = (await getUnitIdForServerKey(payload.server_key)) ?? (await getDefaultUnitId());
    const operationResult = await tx.query<{
      id: string;
      status: OperationStatus;
    }>(
      `
      INSERT INTO operations (
        server_key,
        unit_id,
        mission_uid,
        mission_name,
        world_name,
        raw_start_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING id, status
      `,
      [
        payload.server_key,
        unitId,
        getMissionField(payload.mission, "mission_uid"),
        getMissionField(payload.mission, "mission_name"),
        getMissionField(payload.mission, "world_name"),
        JSON.stringify(payload)
      ]
    );
    const operation = operationResult.rows[0];

    if (!operation) {
      throw new Error("Operation start insert returned no rows.");
    }

    const response: OperationIngestResponse = {
      ok: true,
      operation_id: operation.id,
      status: operation.status,
      accepted: true,
      idempotent: false,
      queued: true
    };

    await insertIngestRequest(tx, payload.request_id, operation.id, "/v1/operations/start", payload, response);
    await insertOperationIngestJob(tx, payload.request_id, operation.id, "/v1/operations/start", "start", payload);

    return {
      requestId: payload.request_id,
      response,
      enqueued: true
    };
  });
}

export async function enqueueFinishOperationIngest(
  operationId: string,
  payload: OperationFinishBody
): Promise<EnqueueResult> {
  return withDbTransaction(async (tx) => {
    const existingResponse = await getExistingIngestResponse(tx, payload.request_id);

    if (existingResponse) {
      return {
        requestId: payload.request_id,
        response: replayResponse(existingResponse),
        enqueued: false
      };
    }

    const existingOperation = await getFinishOperation(tx, operationId);

    if (!existingOperation) {
      throw new OperationRouteError(404, "operation_not_found", "Operation was not found.");
    }

    if (existingOperation.server_key !== payload.server_key) {
      throw new OperationRouteError(409, "server_key_mismatch", "Server key did not match operation.");
    }

    const finishStatus = statusForFinishOutcome(payload.outcome);

    await tx.query(
      `
      UPDATE operations
      SET
        status = $2,
        ended_at = COALESCE(ended_at, now()),
        mission_uid = COALESCE(mission_uid, $3),
        mission_name = COALESCE(mission_name, $4),
        world_name = COALESCE(world_name, $5),
        raw_end_payload = $6::jsonb,
        updated_at = now()
      WHERE id = $1
      `,
      [
        operationId,
        finishStatus,
        getMissionField(payload.mission, "mission_uid"),
        getMissionField(payload.mission, "mission_name"),
        getMissionField(payload.mission, "world_name"),
        JSON.stringify(payload)
      ]
    );

    const response: OperationIngestResponse = {
      ok: true,
      operation_id: operationId,
      status: finishStatus,
      outcome: payload.outcome,
      accepted: true,
      idempotent: false,
      queued: true
    };

    await insertIngestRequest(tx, payload.request_id, operationId, "/v1/operations/:operation_id/finish", payload, response);
    await insertOperationIngestJob(
      tx,
      payload.request_id,
      operationId,
      "/v1/operations/:operation_id/finish",
      "finish",
      payload
    );

    return {
      requestId: payload.request_id,
      response,
      enqueued: true
    };
  });
}

async function claimNextOperationIngestJob(workerSlot: number): Promise<OperationIngestJob | null> {
  const result = await queryDb<OperationIngestJob>(
    `
    WITH next_job AS (
      SELECT q.id
      FROM operation_ingest_jobs q
      WHERE q.status = 'pending'
        AND q.available_at <= now()
        AND q.attempt_count < $2
        AND NOT EXISTS (
          SELECT 1
          FROM operation_ingest_jobs earlier
          WHERE earlier.operation_id = q.operation_id
            AND (
              earlier.created_at < q.created_at
              OR (earlier.created_at = q.created_at AND earlier.id < q.id)
            )
            AND earlier.status IN ('pending', 'processing')
        )
      ORDER BY q.created_at ASC, q.id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE operation_ingest_jobs q
    SET
      status = 'processing',
      attempt_count = q.attempt_count + 1,
      locked_at = now(),
      locked_by = $1,
      updated_at = now()
    FROM next_job
    WHERE q.id = next_job.id
    RETURNING q.id, q.request_id, q.operation_id, q.kind, q.payload, q.attempt_count
    `,
    [`${workerId}:${workerSlot}`, config.operationIngestQueueMaxAttempts]
  );

  return result.rows[0] ?? null;
}

async function completeOperationIngestJob(job: OperationIngestJob): Promise<void> {
  if (job.kind === "start") {
    const payload = operationStartBodySchema.parse(job.payload);
    await completeQueuedStartOperationIngest(job.operation_id, payload);
    return;
  }

  const payload = operationFinishBodySchema.parse(job.payload);
  await completeQueuedFinishOperationIngest(job.operation_id, payload);
}

async function markOperationIngestJobCompleted(job: OperationIngestJob): Promise<void> {
  await queryDb(
    `
    UPDATE operation_ingest_jobs
    SET
      status = 'completed',
      completed_at = now(),
      locked_at = NULL,
      locked_by = NULL,
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = now()
    WHERE id = $1
    `,
    [job.id]
  );
}

async function markOperationIngestJobFailed(job: OperationIngestJob, error: unknown): Promise<void> {
  const permanent = error instanceof OperationRouteError || job.attempt_count >= config.operationIngestQueueMaxAttempts;
  const code = error instanceof OperationRouteError ? error.code : "operation_ingest_processing_failed";
  const message =
    error instanceof OperationRouteError
      ? error.publicMessage
      : permanent
        ? "Queued operation package could not be processed."
        : "Queued operation package processing will be retried.";
  const nextStatus: OperationIngestJobStatus = permanent ? "failed" : "pending";

  await withDbTransaction(async (tx) => {
    await tx.query(
      `
      UPDATE operation_ingest_jobs
      SET
        status = $2,
        available_at = CASE
          WHEN $5::boolean THEN available_at
          ELSE now() + make_interval(secs => ($6::int * GREATEST(attempt_count, 1)))
        END,
        locked_at = NULL,
        locked_by = NULL,
        last_error_code = $3,
        last_error_message = $4,
        updated_at = now()
      WHERE id = $1
      `,
      [job.id, nextStatus, code, message, permanent, config.operationIngestQueueRetryDelaySeconds]
    );

    if (permanent) {
      await updateIngestRequestResponse(tx, job.request_id, queuedFailureResponse(code, message));
    }
  });
}

async function drainOperationIngestQueueWorker(workerSlot: number, log?: FastifyBaseLogger): Promise<void> {
  for (;;) {
    const job = await claimNextOperationIngestJob(workerSlot);

    if (!job) {
      return;
    }

    try {
      log?.debug(
        {
          workerSlot,
          queueWorkerId: workerId,
          operationIngestJobId: job.id,
          requestId: job.request_id,
          operationId: job.operation_id,
          kind: job.kind
        },
        "Processing queued operation ingest job"
      );
      await completeOperationIngestJob(job);
      await markOperationIngestJobCompleted(job);
    } catch (error) {
      log?.error(
        {
          err: error,
          dbError: getSafeDbErrorDetails(error),
          workerSlot,
          queueWorkerId: workerId,
          operationIngestJobId: job.id,
          requestId: job.request_id,
          operationId: job.operation_id,
          kind: job.kind
        },
        "Failed to process queued operation ingest job"
      );
      await markOperationIngestJobFailed(job, error);
    }
  }
}

export async function drainOperationIngestQueue(log?: FastifyBaseLogger): Promise<void> {
  if (drainPromise) {
    return drainPromise;
  }

  drainPromise = (async () => {
    try {
      const workerSlots = Array.from({ length: config.operationIngestQueueWorkers }, (_, index) => index + 1);
      await mapWithConcurrency(workerSlots, config.operationIngestQueueWorkers, (workerSlot) =>
        drainOperationIngestQueueWorker(workerSlot, log)
      );
    } finally {
      drainPromise = null;
    }
  })();

  return drainPromise;
}

function isQueuedResponse(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    "queued" in response &&
    (response as { queued?: unknown }).queued === true
  );
}

async function getStoredIngestResponse(requestId: string): Promise<unknown | null> {
  const result = await queryDb<{ response: unknown }>("SELECT response FROM ingest_requests WHERE request_id = $1", [
    requestId
  ]);

  return result.rows[0]?.response ?? null;
}

export async function waitForOperationIngestResponse(requestId: string, fallback: unknown): Promise<unknown> {
  const timeoutAt = Date.now() + config.operationIngestQueueSyncWaitMs;

  while (Date.now() < timeoutAt) {
    const response = await getStoredIngestResponse(requestId);

    if (response && !isQueuedResponse(response)) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return fallback;
}

export function scheduleOperationIngestQueue(log: FastifyBaseLogger): () => void {
  const run = () => {
    void drainOperationIngestQueue(log).catch((error) => {
      log.error({ err: error, dbError: getSafeDbErrorDetails(error) }, "Operation ingest queue worker failed");
    });
  };

  run();
  const interval = setInterval(run, config.operationIngestQueuePollMs);
  interval.unref();

  return () => clearInterval(interval);
}
