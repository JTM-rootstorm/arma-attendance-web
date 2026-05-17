import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireBearerToken } from "../auth.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";

const ingestRequestParamsSchema = z.object({
  request_id: z.string().min(1).max(200)
});

type IngestRequestRow = {
  request_id: string;
  operation_id: string | null;
  endpoint: string;
  payload: unknown;
  response: unknown;
  received_at: Date;
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

export async function registerIngestRequestRoutes(app: FastifyInstance) {
  app.get("/v1/ingest-requests/:request_id", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsedParams = ingestRequestParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const ingestRequestResult = await queryDb<IngestRequestRow>(
        `
        SELECT
          request_id,
          operation_id,
          endpoint,
          payload,
          response,
          received_at
        FROM ingest_requests
        WHERE request_id = $1
        `,
        [parsedParams.data.request_id]
      );

      const ingestRequest = ingestRequestResult.rows[0];

      if (!ingestRequest) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "ingest_request_not_found",
            message: "Ingest request was not found."
          }
        });
      }

      return {
        ok: true,
        ingest_request: ingestRequest
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch ingest request");
      return sendDatabaseUnavailable(reply);
    }
  });
}
