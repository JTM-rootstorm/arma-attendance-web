import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { hasRole, requireBearerToken, type CurrentUser } from "../auth.js";
import { canSeeSensitiveIds, deny, getAuthContext, getReadableUnitFilter } from "../auth/authorization.js";
import { canReadOperation, getLinkedPlayerUid } from "../auth/operationAccess.js";
import { getDefaultUnitId, hasUnitRole } from "../auth/units.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { type DbTransaction, withDbTransaction } from "../db/transactions.js";
import { persistOperationAttendance, type NormalizationSummary } from "../normalization/operationAttendance.js";
import { redactAttendance, redactOperation, redactOperationListItem } from "../privacy/redaction.js";

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

const operationListQuerySchema = z.object({
  server_key: z.string().max(128).optional(),
  status: z.enum(["started", "finished", "abandoned"]).optional(),
  mission_uid: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

type OperationStatus = "started" | "finished" | "abandoned";

type OperationIngestResponse = {
  ok: true;
  operation_id: string;
  status: OperationStatus;
  accepted: true;
  idempotent: boolean;
  normalized?: NormalizationSummary;
};

type OperationRow = {
  id: string;
  unit_id: string | null;
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

type OperationListRow = {
  id: string;
  unit_id: string | null;
  server_key: string;
  status: OperationStatus;
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  payload_count: number;
};

type OperationPayloadRow = {
  id: string;
  kind: "start" | "finish";
  request_id: string;
  received_at: Date;
  payload: unknown;
};

type OperationUnitRow = {
  id: string;
  unit_id: string | null;
};

type OperationDeleteRow = {
  id: string;
  unit_id: string | null;
  server_key: string;
  mission_uid: string | null;
  mission_name: string | null;
};

type OperationAttendanceRow = {
  player_uid: string;
  name_at_start: string | null;
  name_at_end: string | null;
  side_at_start: string | null;
  side_at_end: string | null;
  group_at_start: string | null;
  group_at_end: string | null;
  role_at_start: string | null;
  role_at_end: string | null;
  unit_class_at_start: string | null;
  unit_class_at_end: string | null;
  vehicle_class_at_start: string | null;
  vehicle_class_at_end: string | null;
  present_at_start: boolean;
  present_at_end: boolean;
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

function canSeeOperationPlayerIds(user: CurrentUser | null): boolean {
  return user === null || hasRole(user, ["admin"]);
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

function canDeleteOperation(user: CurrentUser): boolean {
  return hasRole(user, ["admin"]);
}

function getMissionField(
  mission: z.infer<typeof missionSchema>,
  key: "mission_uid" | "mission_name" | "world_name"
): string | null {
  return mission?.[key] ?? null;
}

export async function registerOperationRoutes(app: FastifyInstance) {
  app.get("/v1/operations", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { allowMachineToken: true });

    if (!auth) {
      return;
    }

    const parsedQuery = operationListQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const query = parsedQuery.data;
    const where: string[] = [];
    const values: unknown[] = [];
    const unitFilter = await getReadableUnitFilter(auth.user);

    const operationUnitIds =
      auth.user && !unitFilter.all
        ? (await Promise.all(
            unitFilter.unitIds.map(async (unitId) => ((await hasUnitRole(auth.user as CurrentUser, unitId, "officer")) ? unitId : null))
          )).filter((unitId): unitId is string => unitId !== null)
        : unitFilter.unitIds;

    if (auth.user && !unitFilter.all && operationUnitIds.length === 0) {
      const playerUid = await getLinkedPlayerUid(auth.user);

      if (!playerUid) {
        return {
          ok: true,
          operations: [],
          pagination: {
            limit: query.limit,
            offset: query.offset,
            count: 0
          }
        };
      }

      values.push(playerUid);
      where.push(`EXISTS (
        SELECT 1
        FROM operation_players self_op
        WHERE self_op.operation_id = o.id
          AND self_op.player_uid = $${values.length}
      )`);
    } else if (!unitFilter.all) {
      values.push(operationUnitIds);
      where.push(`o.unit_id = ANY($${values.length}::uuid[])`);
    }

    if (query.server_key) {
      values.push(query.server_key);
      where.push(`o.server_key = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      where.push(`o.status = $${values.length}`);
    }

    if (query.mission_uid) {
      values.push(query.mission_uid);
      where.push(`o.mission_uid = $${values.length}`);
    }

    values.push(query.limit);
    const limitParam = values.length;
    values.push(query.offset);
    const offsetParam = values.length;

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    try {
      const operationsResult = await queryDb<OperationListRow>(
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
          COUNT(op.id)::int AS payload_count
        FROM operations o
        LEFT JOIN operation_payloads op ON op.operation_id = o.id
        ${whereClause}
        GROUP BY o.id
        ORDER BY o.started_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return {
        ok: true,
        operations: operationsResult.rows.map((row) => redactOperationListItem(row, canSeeSensitiveIds(auth.user))),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          count: operationsResult.rows.length
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list operations");
      return sendDatabaseUnavailable(reply);
    }
  });

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

        const defaultUnitId = await getDefaultUnitId();
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
            defaultUnitId,
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
        const normalized = await persistOperationAttendance(tx, operation.id, "start", payload);

        const response: OperationIngestResponse = {
          ok: true,
          operation_id: operation.id,
          status: operation.status,
          accepted: true,
          idempotent: false,
          normalized
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
        const normalized = await persistOperationAttendance(tx, operationId, "finish", payload);

        const response: OperationIngestResponse = {
          ok: true,
          operation_id: updatedOperation.id,
          status: updatedOperation.status,
          accepted: true,
          idempotent: false,
          normalized
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

  app.get("/v1/operations/:operation_id/payloads", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { allowMachineToken: true });

    if (!auth) {
      return;
    }

    if (auth.user && !canSeeSensitiveIds(auth.user)) {
      return deny(reply);
    }

    const parsedParams = operationParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { operation_id: operationId } = parsedParams.data;

    try {
      const operationResult = await queryDb<OperationUnitRow>("SELECT id, unit_id FROM operations WHERE id = $1", [operationId]);
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

      if (auth.user && !(await canReadOperation(auth.user, operation.id, operation.unit_id))) {
        return deny(reply);
      }

      const payloadResult = await queryDb<OperationPayloadRow>(
        `
        SELECT id, kind, request_id, received_at, payload
        FROM operation_payloads
        WHERE operation_id = $1
        ORDER BY received_at ASC
        `,
        [operationId]
      );

      return {
        ok: true,
        operation_id: operationId,
        payloads: payloadResult.rows
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch operation payloads");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/operations/:operation_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = operationParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { operation_id: operationId } = parsedParams.data;

    if (!canDeleteOperation(auth.user)) {
      return sendOperationRouteError(
        reply,
        new OperationRouteError(403, "forbidden", "The authenticated user does not have permission for this action.")
      );
    }

    try {
      const result = await withDbTransaction(async (tx) => {
        const operationResult = await tx.query<OperationDeleteRow>(
          `
          SELECT id, unit_id, server_key, mission_uid, mission_name
          FROM operations
          WHERE id = $1
          FOR UPDATE
          `,
          [operationId]
        );
        const operation = operationResult.rows[0];

        if (!operation) {
          return {
            operation_id: operationId,
            operation_deleted: false,
            ingest_requests_deleted: 0
          };
        }

        const ingestResult = await tx.query("DELETE FROM ingest_requests WHERE operation_id = $1", [operation.id]);
        await tx.query("DELETE FROM operations WHERE id = $1", [operation.id]);
        await tx.query(
          `
          INSERT INTO admin_audit_events (actor_user_id, actor_label, action, details)
          VALUES ($1, $2, 'delete_operation', $3::jsonb)
          `,
          [
            auth.user.id,
            auth.user.display_name ?? auth.user.id,
            JSON.stringify({
              operation_id: operation.id,
              server_key: operation.server_key,
              mission_uid: operation.mission_uid,
              mission_name: operation.mission_name,
              ingest_requests_deleted: ingestResult.rowCount ?? 0
            })
          ]
        );

        return {
          operation_id: operation.id,
          operation_deleted: true,
          ingest_requests_deleted: ingestResult.rowCount ?? 0
        };
      });

      return {
        ok: true,
        ...result
      };
    } catch (error) {
      if (error instanceof OperationRouteError) {
        return sendOperationRouteError(reply, error);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to delete operation");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/operations/:operation_id/attendance", async (request, reply) => {
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
      const operationResult = await queryDb<OperationUnitRow>("SELECT id, unit_id FROM operations WHERE id = $1", [operationId]);
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

      if (auth.user && !(await canReadOperation(auth.user, operation.id, operation.unit_id))) {
        return deny(reply);
      }

      const attendanceResult = await queryDb<OperationAttendanceRow>(
        `
        SELECT
          op.player_uid,
          op.name_at_start,
          op.name_at_end,
          op.side_at_start,
          op.side_at_end,
          op.group_at_start,
          op.group_at_end,
          op.role_at_start,
          op.role_at_end,
          op.unit_class_at_start,
          op.unit_class_at_end,
          op.vehicle_class_at_start,
          op.vehicle_class_at_end,
          op.present_at_start,
          op.present_at_end,
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
        LEFT JOIN operation_player_stats ops
          ON ops.operation_id = op.operation_id
          AND ops.player_uid = op.player_uid
        WHERE op.operation_id = $1
        ORDER BY COALESCE(op.name_at_end, op.name_at_start, op.player_uid), op.player_uid
        `,
        [operationId]
      );

      const revealPlayerIds = canSeeOperationPlayerIds(auth.user);

      return {
        ok: true,
        operation_id: operationId,
        attendance: attendanceResult.rows.map((row) => redactAttendance({
          player_uid: row.player_uid,
          name_at_start: row.name_at_start,
          name_at_end: row.name_at_end,
          side_at_start: row.side_at_start,
          side_at_end: row.side_at_end,
          group_at_start: row.group_at_start,
          group_at_end: row.group_at_end,
          role_at_start: row.role_at_start,
          role_at_end: row.role_at_end,
          unit_class_at_start: row.unit_class_at_start,
          unit_class_at_end: row.unit_class_at_end,
          vehicle_class_at_start: row.vehicle_class_at_start,
          vehicle_class_at_end: row.vehicle_class_at_end,
          present_at_start: row.present_at_start,
          present_at_end: row.present_at_end,
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
        }, revealPlayerIds))
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch operation attendance");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/operations/:operation_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { allowMachineToken: true });

    if (!auth) {
      return;
    }

    const parsedParams = operationParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const operationResult = await queryDb<OperationRow>(
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

      if (auth.user && !(await canReadOperation(auth.user, operation.id, operation.unit_id))) {
        return deny(reply);
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
        operation: redactOperation(operation, canSeeSensitiveIds(auth.user)),
        payloads: payloadResult.rows
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch operation");
      return sendDatabaseUnavailable(reply);
    }
  });
}
