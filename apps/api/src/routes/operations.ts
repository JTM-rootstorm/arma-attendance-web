import type { FastifyInstance, FastifyReply } from "fastify";

import { requireBearerToken } from "../auth.js";
import { canSeeSensitiveIds, deny, getAuthContext, getOptionalAuthContext } from "../auth/authorization.js";
import { machineTokenKindSets } from "../auth/machineTokenKinds.js";
import { canReadOperation } from "../auth/operationAccess.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { canDeleteOperation, deleteOperationWithAudit } from "../operations/operationDeletion.js";
import {
  canSeeOperationAttendancePlayerIds,
  getOperationAttendance,
  getOperationDetail,
  getOperationPayloads,
  getOperationUnit,
  listOperations
} from "../operations/operationQueries.js";
import {
  drainOperationIngestQueue,
  enqueueFinishOperationIngest,
  enqueueStartOperationIngest,
  waitForOperationIngestResponse
} from "../operations/operationIngestQueue.js";
import { OperationRouteError } from "../operations/types.js";
import { redactAttendance, redactOperation } from "../privacy/redaction.js";
import { logValidationFailed, sendDatabaseUnavailable, sendForbidden, sendValidationFailed } from "../http/responses.js";
import { operationFinishBodySchema, operationListQuerySchema, operationParamsSchema, operationStartBodySchema } from "./operations/schemas.js";

function sendOperationRouteError(reply: FastifyReply, error: OperationRouteError) {
  return reply.code(error.statusCode).send({
    ok: false,
    error: {
      code: error.code,
      message: error.publicMessage
    }
  });
}

function sendOperationNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    ok: false,
    error: {
      code: "operation_not_found",
      message: "Operation was not found."
    }
  });
}

function kickOperationIngestQueue(requestLog: FastifyInstance["log"]) {
  void drainOperationIngestQueue(requestLog).catch((error) => {
    requestLog.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to drain operation ingest queue");
  });
}

export async function registerOperationRoutes(app: FastifyInstance) {
  app.get("/v1/operations", async (request, reply) => {
    const auth = await getOptionalAuthContext(request, {
      machineTokenKinds: machineTokenKindSets.userReadable
    });

    const parsedQuery = operationListQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      logValidationFailed(request.log, "GET /v1/operations", [parsedQuery.error]);
      return sendValidationFailed(reply);
    }

    try {
      return await listOperations(auth, parsedQuery.data);
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list operations");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/operations/start", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsed = operationStartBodySchema.safeParse(request.body);

    if (!parsed.success) {
      logValidationFailed(request.log, "POST /v1/operations/start", [parsed.error]);
      return sendValidationFailed(reply);
    }

    try {
      const enqueued = await enqueueStartOperationIngest(parsed.data);
      if (!enqueued.enqueued) {
        return enqueued.response;
      }

      kickOperationIngestQueue(request.log);
      return await waitForOperationIngestResponse(enqueued.requestId, enqueued.response);
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to start operation ingest");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/operations/:operation_id/finish", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsedParams = operationParamsSchema.safeParse(request.params);
    const parsedBody = operationFinishBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      logValidationFailed(
        request.log,
        "POST /v1/operations/:operation_id/finish",
        [
          ...(!parsedParams.success ? [parsedParams.error] : []),
          ...(!parsedBody.success ? [parsedBody.error] : [])
        ]
      );
      return sendValidationFailed(reply);
    }

    try {
      const enqueued = await enqueueFinishOperationIngest(parsedParams.data.operation_id, parsedBody.data);
      if (!enqueued.enqueued) {
        return enqueued.response;
      }

      kickOperationIngestQueue(request.log);
      return await waitForOperationIngestResponse(enqueued.requestId, enqueued.response);
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

    if (auth.user && !canSeeSensitiveIds(auth.user, auth.machineTokenKind)) {
      return deny(reply);
    }

    const parsedParams = operationParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      logValidationFailed(request.log, "GET /v1/operations/:operation_id/payloads", [parsedParams.error]);
      return sendValidationFailed(reply);
    }

    const { operation_id: operationId } = parsedParams.data;

    try {
      const operation = await getOperationUnit(operationId);

      if (!operation) {
        return sendOperationNotFound(reply);
      }

      if (auth.user && !(await canReadOperation(auth.user, operation.id, operation.unit_id))) {
        return deny(reply);
      }

      return {
        ok: true,
        operation_id: operationId,
        payloads: await getOperationPayloads(operationId)
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
      logValidationFailed(request.log, "DELETE /v1/operations/:operation_id", [parsedParams.error]);
      return sendValidationFailed(reply);
    }

    if (!canDeleteOperation(auth.user)) {
      return sendForbidden(reply);
    }

    try {
      return {
        ok: true,
        ...(await deleteOperationWithAudit(parsedParams.data.operation_id, auth.user))
      };
    } catch (error) {
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
      logValidationFailed(request.log, "GET /v1/operations/:operation_id/attendance", [parsedParams.error]);
      return sendValidationFailed(reply);
    }

    const { operation_id: operationId } = parsedParams.data;

    try {
      const operation = await getOperationUnit(operationId);

      if (!operation) {
        return sendOperationNotFound(reply);
      }

      if (auth.user && !(await canReadOperation(auth.user, operation.id, operation.unit_id))) {
        return deny(reply);
      }

      const revealPlayerIds = canSeeOperationAttendancePlayerIds(auth.user);
      const attendance = await getOperationAttendance(operationId);

      return {
        ok: true,
        operation_id: operationId,
        attendance: attendance.map((row) => redactAttendance({
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
      logValidationFailed(request.log, "GET /v1/operations/:operation_id", [parsedParams.error]);
      return sendValidationFailed(reply);
    }

    try {
      const { operation, payloads } = await getOperationDetail(parsedParams.data.operation_id);

      if (!operation) {
        return sendOperationNotFound(reply);
      }

      if (auth.user && !(await canReadOperation(auth.user, operation.id, operation.unit_id))) {
        return deny(reply);
      }

      return {
        ok: true,
        operation: redactOperation(operation, canSeeSensitiveIds(auth.user, auth.machineTokenKind)),
        payloads
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch operation");
      return sendDatabaseUnavailable(reply);
    }
  });
}
