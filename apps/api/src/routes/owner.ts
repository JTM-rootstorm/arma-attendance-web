import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { hashMachineToken, requireRole, requireUser, type MachineTokenKind } from "../auth.js";
import { config } from "../config.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { withDbTransaction, type DbTransaction } from "../db/transactions.js";
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
  token_kind: (typeof tokenKinds)[number];
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

async function auditMachineToken(
  tx: DbTransaction,
  actor: { id: string; display_name: string | null },
  action: string,
  details: Record<string, unknown>
) {
  await tx.query(
    `
    INSERT INTO admin_audit_events (actor_user_id, actor_label, action, details)
    VALUES ($1, $2, $3, $4::jsonb)
    `,
    [actor.id, actor.display_name ?? actor.id, action, JSON.stringify(details)]
  );
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
      const result = await queryDb<MachineTokenRow>(
        `
        SELECT id, name, token_kind, token_prefix, is_active, created_at, last_used_at, revoked_at
        FROM machine_tokens
        ORDER BY created_at DESC
        `
      );

      await queryDb(
        `
        INSERT INTO admin_audit_events (actor_user_id, actor_label, action, details)
        VALUES ($1, $2, 'machine_token_list_viewed', '{}'::jsonb)
        `,
        [actor.id, actor.display_name ?? actor.id]
      );

      return {
        ok: true,
        tokens: result.rows.map(serializeMachineToken),
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
      const record = await withDbTransaction(async (tx) => {
        const result = await tx.query<MachineTokenRow>(
          `
          INSERT INTO machine_tokens (
            name,
            token_hash,
            token_prefix,
            token_kind,
            created_by_user_id
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, name, token_kind, token_prefix, is_active, created_at, last_used_at, revoked_at
          `,
          [parsedBody.data.name, hashMachineToken(token), tokenPrefix(token), parsedBody.data.token_kind, actor.id]
        );
        const row = result.rows[0];

        if (!row) {
          throw new Error("Machine token insert returned no rows.");
        }

        await auditMachineToken(tx, actor, "machine_token_created", {
          token_id: row.id,
          token_kind: row.token_kind,
          token_prefix: row.token_prefix
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
      const revoked = await withDbTransaction(async (tx) => {
        const result = await tx.query<MachineTokenRow>(
          `
          UPDATE machine_tokens
          SET
            is_active = false,
            revoked_at = COALESCE(revoked_at, now()),
            revoked_by_user_id = $2
          WHERE id = $1
          RETURNING id, name, token_kind, token_prefix, is_active, created_at, last_used_at, revoked_at
          `,
          [parsedParams.data.token_id, actor.id]
        );
        const row = result.rows[0];

        if (!row) {
          return null;
        }

        await auditMachineToken(tx, actor, "machine_token_revoked", {
          token_id: row.id,
          token_kind: row.token_kind,
          token_prefix: row.token_prefix
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
