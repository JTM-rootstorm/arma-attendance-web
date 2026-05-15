import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireBearerToken } from "../auth.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { type DbTransaction, withDbTransaction } from "../db/transactions.js";

const missionSchema = z
  .object({
    mission_uid: z.string().max(200).optional(),
    mission_name: z.string().max(300).optional(),
    world_name: z.string().max(200).optional()
  })
  .passthrough()
  .optional();

const operationStartBodySchema = z
  .object({
    request_id: z.string().min(1).max(200),
    server_key: z.string().min(1).max(128),
    payload_version: z.number().int().positive().optional(),
    mission: missionSchema
  })
  .passthrough();

const operationFinishBodySchema = z
  .object({
    request_id: z.string().min(1).max(200),
    server_key: z.string().min(1).max(128),
    payload_version: z.number().int().positive().optional(),
    mission: missionSchema
  })
  .passthrough();

const operationParamsSchema = z.object({
  operation_id: z.string().uuid()
});

type OperationStatus = "started" | "finished" | "abandoned";

type OperationIngestResponse = {
  ok: true;
  operation_id: string;
  status: OperationStatus;
  accepted: true;
  idempotent: boolean;
};

type OperationRow = {
  id: string;
  server_key: string;
  status: OperationStatus;
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  raw_start_payload: unknown;
  raw_end_payload: unknown;
};

class OperationRouteError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly publicMessage: string;

  public constructor(statusCode: number, code: string, publicMessage: string) {
    super(publicMessage);
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = publicMessage;
  }
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

function sendOperationRouteError(reply: FastifyReply, error: OperationRouteError) {
  return reply.code(error.statusCode).send({
    ok: false,
    error: {
      code: error.code,
      message: error.publicMessage
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

function replayResponse(response: unknown): OperationIngestResponse | unknown {
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    return {
      ...response,
      idempotent: true
    };
  }

  return response;
}

async function getExistingIngestResponse(tx: DbTransaction, requestId: string): Promise<unknown | null> {
  const result = await tx.query<{ response: unknown }>("SELECT response FROM ingest_requests WHERE request_id = $1", [
    requestId
  ]);

  return result.rows[0]?.response ?? null;
}

async function insertOperationPayload(
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

async function insertIngestRequest(
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

function getMissionField(
  mission: z.infer<typeof missionSchema>,
  key: "mission_uid" | "mission_name" | "world_name"
): string | null {
  return mission?.[key] ?? null;
}

export async function registerOperationRoutes(app: FastifyInstance) {
  app.post("/v1/operations/start", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsed = operationStartBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const payload = parsed.data;

    try {
      return await withDbTransaction(async (tx) => {
        const existingResponse = await getExistingIngestResponse(tx, payload.request_id);

        if (existingResponse) {
          return replayResponse(existingResponse);
        }

        const operationResult = await tx.query<{
          id: string;
          status: OperationStatus;
        }>(
          `
          INSERT INTO operations (
            server_key,
            mission_uid,
            mission_name,
            world_name,
            raw_start_payload
          )
          VALUES ($1, $2, $3, $4, $5::jsonb)
          RETURNING id, status
          `,
          [
            payload.server_key,
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

        await insertOperationPayload(tx, operation.id, payload.request_id, "start", payload);

        const response: OperationIngestResponse = {
          ok: true,
          operation_id: operation.id,
          status: operation.status,
          accepted: true,
          idempotent: false
        };

        await insertIngestRequest(tx, payload.request_id, operation.id, "/v1/operations/start", payload, response);

        return response;
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to start operation ingest");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/operations/:operation_id/finish", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsedParams = operationParamsSchema.safeParse(request.params);
    const parsedBody = operationFinishBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const { operation_id: operationId } = parsedParams.data;
    const payload = parsedBody.data;

    try {
      return await withDbTransaction(async (tx) => {
        const existingResponse = await getExistingIngestResponse(tx, payload.request_id);

        if (existingResponse) {
          return replayResponse(existingResponse);
        }

        const existingOperationResult = await tx.query<{
          id: string;
          server_key: string;
          status: OperationStatus;
        }>(
          `
          SELECT id, server_key, status
          FROM operations
          WHERE id = $1
          FOR UPDATE
          `,
          [operationId]
        );

        const existingOperation = existingOperationResult.rows[0];

        if (!existingOperation) {
          throw new OperationRouteError(404, "operation_not_found", "Operation was not found.");
        }

        if (existingOperation.server_key !== payload.server_key) {
          throw new OperationRouteError(409, "server_key_mismatch", "Server key did not match operation.");
        }

        const updateResult = await tx.query<{
          id: string;
          status: OperationStatus;
        }>(
          `
          UPDATE operations
          SET
            status = 'finished',
            ended_at = COALESCE(ended_at, now()),
            mission_uid = COALESCE(mission_uid, $2),
            mission_name = COALESCE(mission_name, $3),
            world_name = COALESCE(world_name, $4),
            raw_end_payload = $5::jsonb,
            updated_at = now()
          WHERE id = $1
          RETURNING id, status
          `,
          [
            operationId,
            getMissionField(payload.mission, "mission_uid"),
            getMissionField(payload.mission, "mission_name"),
            getMissionField(payload.mission, "world_name"),
            JSON.stringify(payload)
          ]
        );

        const updatedOperation = updateResult.rows[0];

        if (!updatedOperation) {
          throw new Error("Operation finish update returned no rows.");
        }

        await insertOperationPayload(tx, operationId, payload.request_id, "finish", payload);

        const response: OperationIngestResponse = {
          ok: true,
          operation_id: updatedOperation.id,
          status: updatedOperation.status,
          accepted: true,
          idempotent: false
        };

        await insertIngestRequest(
          tx,
          payload.request_id,
          operationId,
          "/v1/operations/:operation_id/finish",
          payload,
          response
        );

        return response;
      });
    } catch (error) {
      if (error instanceof OperationRouteError) {
        return sendOperationRouteError(reply, error);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to finish operation ingest");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/operations/:operation_id", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsedParams = operationParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const operationResult = await queryDb<OperationRow>(
        `
        SELECT
          id,
          server_key,
          status,
          mission_uid,
          mission_name,
          world_name,
          started_at,
          ended_at,
          raw_start_payload,
          raw_end_payload
        FROM operations
        WHERE id = $1
        `,
        [parsedParams.data.operation_id]
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

      const payloadResult = await queryDb<{
        id: string;
        kind: "start" | "finish";
        request_id: string;
        received_at: Date;
      }>(
        `
        SELECT id, kind, request_id, received_at
        FROM operation_payloads
        WHERE operation_id = $1
        ORDER BY received_at ASC
        `,
        [operation.id]
      );

      return {
        ok: true,
        operation,
        payloads: payloadResult.rows
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch operation");
      return sendDatabaseUnavailable(reply);
    }
  });
}
