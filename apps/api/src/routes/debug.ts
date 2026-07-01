import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { requireBearerToken } from "../auth.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { debugPokes } from "../db/schema/operations.js";
import { logValidationFailed } from "../http/responses.js";

const pokeBodySchema = z
  .object({
    request_id: z.string().max(200).optional(),
    message: z.string().max(500).optional(),
    server_key: z.string().max(128).optional()
  })
  .passthrough();

export async function registerDebugRoutes(app: FastifyInstance) {
  app.post("/v1/debug/poke", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsed = pokeBodySchema.safeParse(request.body);

    if (!parsed.success) {
      logValidationFailed(request.log, "POST /v1/debug/poke", [parsed.error]);
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
      const db = getDrizzleDb();
      const [saved] = await db
        .insert(debugPokes)
        .values({
          requestId: payload.request_id ?? null,
          serverKey: payload.server_key ?? null,
          message: payload.message ?? null,
          sourceIp: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
          payload
        })
        .onConflictDoUpdate({
          target: debugPokes.requestId,
          set: {
            serverKey: sql`excluded.server_key`,
            message: sql`excluded.message`,
            sourceIp: sql`excluded.source_ip`,
            userAgent: sql`excluded.user_agent`,
            payload: sql`excluded.payload`,
            updatedAt: sql`now()`
          }
        })
        .returning({
          id: debugPokes.id,
          created_at: debugPokes.createdAt
        });

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
