import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireBearerToken } from "../auth.js";

const pokeBodySchema = z
  .object({
    message: z.string().max(500).optional(),
    server_key: z.string().max(128).optional()
  })
  .strict();

export async function registerDebugRoutes(app: FastifyInstance) {
  app.post("/v1/debug/poke", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsed = pokeBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: "validation_failed",
          message: "Request body did not match expected shape."
        }
      });
    }

    return {
      ok: true,
      received: true,
      reply: "poke accepted",
      echo: parsed.data
    };
  });
}
