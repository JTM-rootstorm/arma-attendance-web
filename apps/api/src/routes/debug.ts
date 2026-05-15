import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireBearerToken } from "../auth.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";

const pokeBodySchema = z
  .object({
    request_id: z.string().max(200).optional(),
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

    const payload = parsed.data;

    try {
      const result = await queryDb<{
        id: string;
        created_at: Date;
      }>(
        `
        INSERT INTO debug_pokes (
          request_id,
          server_key,
          message,
          source_ip,
          user_agent,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (request_id)
        DO UPDATE SET
          server_key = EXCLUDED.server_key,
          message = EXCLUDED.message,
          source_ip = EXCLUDED.source_ip,
          user_agent = EXCLUDED.user_agent,
          payload = EXCLUDED.payload,
          updated_at = now()
        RETURNING id, created_at
        `,
        [
          payload.request_id ?? null,
          payload.server_key ?? null,
          payload.message ?? null,
          request.ip,
          request.headers["user-agent"] ?? null,
          JSON.stringify(payload)
        ]
      );

      const saved = result.rows[0];

      if (!saved) {
        throw new Error("Debug poke insert returned no rows.");
      }

      return {
        ok: true,
        received: true,
        persisted: true,
        reply: "poke accepted",
        debug_poke_id: saved.id,
        created_at: saved.created_at,
        echo: payload
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to persist debug poke");

      return reply.code(503).send({
        ok: false,
        error: {
          code: "database_unavailable",
          message: "Database is not available."
        }
      });
    }
  });
}
