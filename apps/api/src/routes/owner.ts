import type { FastifyInstance } from "fastify";

import { requireRole } from "../auth.js";
import { config } from "../config.js";
import { tokenPreview } from "../privacy/redaction.js";

export async function registerOwnerRoutes(app: FastifyInstance) {
  app.get("/v1/owner/api-key", { preHandler: requireRole(["owner"]) }, async () => ({
    ok: true,
    api_key: {
      present: Boolean(config.apiToken),
      source: "env",
      preview: tokenPreview(config.apiToken),
      mutable: false
    }
  }));

  app.post("/v1/owner/api-key/rotate", { preHandler: requireRole(["owner"]) }, async (_request, reply) =>
    reply.code(409).send({
      ok: false,
      error: {
        code: "api_key_env_backed",
        message: "The API key is managed by the environment file and must be rotated there."
      },
      api_key: {
        present: Boolean(config.apiToken),
        source: "env",
        preview: tokenPreview(config.apiToken),
        mutable: false
      }
    })
  );
}
