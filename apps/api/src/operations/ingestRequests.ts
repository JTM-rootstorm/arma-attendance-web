import type { DbTransaction } from "../db/transactions.js";
import type { OperationIngestResponse } from "./types.js";

export function replayResponse(response: unknown): OperationIngestResponse | unknown {
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    return {
      ...response,
      idempotent: true
    };
  }

  return response;
}

export async function getExistingIngestResponse(tx: DbTransaction, requestId: string): Promise<unknown | null> {
  const result = await tx.query<{ response: unknown }>("SELECT response FROM ingest_requests WHERE request_id = $1", [
    requestId
  ]);

  return result.rows[0]?.response ?? null;
}

export async function insertOperationPayload(
  tx: DbTransaction,
  operationId: string,
  requestId: string,
  kind: "start" | "finish",
  payload: unknown
): Promise<void> {
  await tx.query(
    `
    INSERT INTO operation_payloads (
      operation_id,
      request_id,
      kind,
      payload
    )
    VALUES ($1, $2, $3, $4::jsonb)
    `,
    [operationId, requestId, kind, JSON.stringify(payload)]
  );
}

export async function insertIngestRequest(
  tx: DbTransaction,
  requestId: string,
  operationId: string,
  endpoint: string,
  payload: unknown,
  response: OperationIngestResponse
): Promise<void> {
  await tx.query(
    `
    INSERT INTO ingest_requests (
      request_id,
      operation_id,
      endpoint,
      payload,
      response
    )
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
    `,
    [requestId, operationId, endpoint, JSON.stringify(payload), JSON.stringify(response)]
  );
}
