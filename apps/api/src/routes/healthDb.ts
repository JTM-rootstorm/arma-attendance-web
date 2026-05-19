import type { FastifyInstance } from "fastify";

import { canSeeApiSecrets, deny, getAuthContext } from "../auth/authorization.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";

export async function registerHealthDbRoutes(app: FastifyInstance) {
  app.get("/health/db", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { allowMachineToken: true });

    if (!auth) {
      return;
    }

    if (auth.user && !canSeeApiSecrets(auth.user)) {
      return deny(reply);
    }

    try {
      const result = await queryDb<{
        current_database: string;
        server_time: Date;
      }>("SELECT current_database() AS current_database, now() AS server_time");

      const row = result.rows[0];

      if (!row) {
        throw new Error("Database health query returned no rows.");
      }

      return {
        ok: true,
        database: {
          connected: true,
          current_database: row.current_database,
          server_time: row.server_time
        }
      };
    } catch (error) {
      app.log.error({ dbError: getSafeDbErrorDetails(error) }, "Database health check failed");

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
