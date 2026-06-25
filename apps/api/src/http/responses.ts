import type { FastifyReply } from "fastify";

export function sendValidationFailed(reply: FastifyReply) {
  return reply.code(400).send({
    ok: false,
    error: {
      code: "validation_failed",
      message: "Request did not match expected shape."
    }
  });
}

export function sendDatabaseUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: {
      code: "database_unavailable",
      message: "Database is not available."
    }
  });
}

export function sendUnauthorized(reply: FastifyReply, message = "Missing or invalid authentication.") {
  return reply.code(401).send({
    ok: false,
    error: {
      code: "unauthorized",
      message
    }
  });
}

export function sendForbidden(reply: FastifyReply, message = "The authenticated user does not have permission for this action.") {
  return reply.code(403).send({
    ok: false,
    error: {
      code: "forbidden",
      message
    }
  });
}
