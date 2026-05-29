import { randomBytes } from "node:crypto";

import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { hashMachineToken, requireRole, requireUser, type MachineTokenKind } from "../auth.js";
import { config } from "../config.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { adminAuditEvents } from "../db/schema/auth.js";
import { machineTokens } from "../db/schema/machineTokens.js";
import { tokenPreview } from "../privacy/redaction.js";

const tokenKinds = ["api", "bot", "arma_server", "base44_integration"] as const satisfies readonly MachineTokenKind[];

const createMachineTokenSchema = z.object({
  name: z.string().trim().min(1).max(120),
  token_kind: z.enum(tokenKinds)
});

const tokenParamsSchema = z.object({
  token_id: z.string().uuid()
});

type MachineTokenRow = {
  id: string;
  name: string;
  token_kind: string;
  token_prefix: string;
  is_active: boolean;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
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

function generateMachineToken(kind: (typeof tokenKinds)[number]): string {
  return `aat_${kind}_${randomBytes(24).toString("base64url")}`;
}

function tokenPrefix(token: string): string {
  return token.slice(0, 18);
}

function serializeMachineToken(row: MachineTokenRow) {
  return {
    id: row.id,
    name: row.name,
    token_kind: row.token_kind,
    token_prefix: row.token_prefix,
    is_active: row.is_active,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at
  };
}

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

  app.get("/v1/system/machine-tokens", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    try {
      const db = getDrizzleDb();
      const rows = await db.transaction(async (tx) => {
        const tokens = await tx
          .select({
            id: machineTokens.id,
            name: machineTokens.name,
            token_kind: machineTokens.tokenKind,
            token_prefix: machineTokens.tokenPrefix,
            is_active: machineTokens.isActive,
            created_at: machineTokens.createdAt,
            last_used_at: machineTokens.lastUsedAt,
            revoked_at: machineTokens.revokedAt
          })
          .from(machineTokens)
          .orderBy(desc(machineTokens.createdAt));

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "machine_token_list_viewed",
          details: {}
        });

        return tokens;
      });

      return {
        ok: true,
        tokens: rows.map(serializeMachineToken),
        env_tokens: {
          api_token_present: Boolean(config.apiToken),
          bot_api_token_present: Boolean(config.botApiToken),
          api_token_source: "env-bootstrap"
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list machine tokens");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/system/machine-tokens", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedBody = createMachineTokenSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    const token = generateMachineToken(parsedBody.data.token_kind);

    try {
      const db = getDrizzleDb();
      const record = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(machineTokens)
          .values({
            name: parsedBody.data.name,
            tokenHash: hashMachineToken(token),
            tokenPrefix: tokenPrefix(token),
            tokenKind: parsedBody.data.token_kind,
            createdByUserId: actor.id
          })
          .returning({
            id: machineTokens.id,
            name: machineTokens.name,
            token_kind: machineTokens.tokenKind,
            token_prefix: machineTokens.tokenPrefix,
            is_active: machineTokens.isActive,
            created_at: machineTokens.createdAt,
            last_used_at: machineTokens.lastUsedAt,
            revoked_at: machineTokens.revokedAt
          });

        if (!row) {
          throw new Error("Machine token insert returned no rows.");
        }

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "machine_token_created",
          details: {
            token_id: row.id,
            token_kind: row.token_kind,
            token_prefix: row.token_prefix
          }
        });

        return row;
      });

      return {
        ok: true,
        token,
        token_record: serializeMachineToken(record)
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create machine token");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/system/machine-tokens/:token_id", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = tokenParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    try {
      const db = getDrizzleDb();
      const revoked = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(machineTokens)
          .set({
            isActive: false,
            revokedAt: sql`COALESCE(${machineTokens.revokedAt}, now())`,
            revokedByUserId: actor.id
          })
          .where(eq(machineTokens.id, parsedParams.data.token_id))
          .returning({
            id: machineTokens.id,
            name: machineTokens.name,
            token_kind: machineTokens.tokenKind,
            token_prefix: machineTokens.tokenPrefix,
            is_active: machineTokens.isActive,
            created_at: machineTokens.createdAt,
            last_used_at: machineTokens.lastUsedAt,
            revoked_at: machineTokens.revokedAt
          });

        if (!row) {
          return null;
        }

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "machine_token_revoked",
          details: {
            token_id: row.id,
            token_kind: row.token_kind,
            token_prefix: row.token_prefix
          }
        });

        return row;
      });

      if (!revoked) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "machine_token_not_found",
            message: "Machine token was not found."
          }
        });
      }

      return { ok: true, token_record: serializeMachineToken(revoked) };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to revoke machine token");
      return sendDatabaseUnavailable(reply);
    }
  });
}
