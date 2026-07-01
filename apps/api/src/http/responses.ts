import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { ZodError } from "zod";

function getValidationIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    code: issue.code,
    message: issue.message
  }));
}

export function logValidationFailed(log: FastifyBaseLogger, route: string, errors: ZodError[]) {
  log.warn(
    {
      route,
      validationIssues: errors.flatMap(getValidationIssues)
    },
    "Request validation failed"
  );
}

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
