import type { FastifyReply, FastifyRequest } from "fastify";

import { config } from "./config.js";

export async function requireBearerToken(request: FastifyRequest, reply: FastifyReply) {
  const expected = `Bearer ${config.apiToken}`;

  if (request.headers.authorization !== expected) {
    return reply.code(401).send({
      ok: false,
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token."
      }
    });
  }
}
