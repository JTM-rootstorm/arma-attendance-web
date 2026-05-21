import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { getCurrentUser, hasRole, requireRole, type AppRole, type CurrentUser } from "../auth.js";
import { hasUnitRole } from "../auth/units.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { withDbTransaction, type DbTransaction } from "../db/transactions.js";

const roles = ["owner", "tcw_admin", "admin", "officer", "viewer"] as const;

const usersQuerySchema = z.object({
  q: z.string().max(200).optional(),
  role: z.enum(roles).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const userParamsSchema = z.object({
  user_id: z.string().uuid()
});

const roleParamsSchema = userParamsSchema.extend({
  role: z.enum(roles)
});

const playerParamsSchema = z.object({
  player_uid: z.string().min(1).max(200)
});

const roleBodySchema = z
  .object({
    reason: z.string().max(1000).optional()
  })
  .optional();

type AdminUserRow = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
  roles: AppRole[] | null;
  identities: Array<{ provider: string; provider_user_id: string; display_name: string | null }> | null;
};

type PlayerNameResetRow = {
  player_uid: string;
  reset_name: string | null;
};

type PlayerUnitRow = {
  unit_id: string;
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

function sendNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    ok: false,
    error: {
      code: "user_not_found",
      message: "User was not found."
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

function sendForbidden(reply: FastifyReply, message: string) {
  return reply.code(403).send({
    ok: false,
    error: {
      code: "forbidden",
      message
    }
  });
}

function serializeUser(row: AdminUserRow) {
  return {
    id: row.id,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    disabled_at: row.disabled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
    roles: row.roles ?? [],
    identities: row.identities ?? []
  };
}

function canManageRole(actor: CurrentUser, role: AppRole): boolean {
  return hasRole(actor, ["owner"]) && (role !== "owner" || actor.roles.includes("owner"));
}

async function userExists(tx: DbTransaction, userId: string): Promise<boolean> {
  const result = await tx.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM app_users WHERE id = $1) AS exists", [
    userId
  ]);
  return result.rows[0]?.exists ?? false;
}

async function ownerCount(tx: DbTransaction): Promise<number> {
  const result = await tx.query<{ total: number }>(
    "SELECT COUNT(*)::int AS total FROM user_roles WHERE role = 'owner'"
  );
  return result.rows[0]?.total ?? 0;
}

async function insertAudit(
  tx: DbTransaction,
  actor: CurrentUser,
  action: string,
  targetUserId: string,
  details: Record<string, unknown>
) {
  await tx.query(
    `
    INSERT INTO admin_audit_events (actor_user_id, actor_label, action, target_user_id, details)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [actor.id, actor.display_name ?? actor.id, action, targetUserId, JSON.stringify(details)]
  );
}

async function canResetPlayerName(actor: CurrentUser, playerUid: string): Promise<boolean> {
  if (hasRole(actor, ["admin"])) {
    return true;
  }

  const units = await queryDb<PlayerUnitRow>("SELECT unit_id FROM unit_players WHERE player_uid = $1", [playerUid]);

  for (const unit of units.rows) {
    if (await hasUnitRole(actor, unit.unit_id, "admin")) {
      return true;
    }
  }

  return false;
}

async function resetPlayerName(tx: DbTransaction, actor: CurrentUser, playerUid: string): Promise<PlayerNameResetRow> {
  const playerResult = await tx.query<PlayerNameResetRow>(
    `
    SELECT
      p.player_uid,
      COALESCE(
        op_names.operation_name,
        p.raw_last_player->>'display_name',
        p.raw_last_player->>'player_name',
        p.raw_last_player->>'name',
        pdl.discord_display_name,
        pdl.discord_username,
        p.player_uid
      ) AS reset_name
    FROM players p
    LEFT JOIN LATERAL (
      SELECT COALESCE(op.name_at_end, op.name_at_start) AS operation_name
      FROM operation_players op
      JOIN operations o ON o.id = op.operation_id
      WHERE op.player_uid = p.player_uid
        AND COALESCE(op.name_at_end, op.name_at_start) IS NOT NULL
      ORDER BY COALESCE(o.ended_at, o.started_at) DESC, op.updated_at DESC
      LIMIT 1
    ) op_names ON true
    LEFT JOIN player_discord_links pdl ON pdl.player_uid = p.player_uid
    WHERE p.player_uid = $1
    ORDER BY pdl.verified_at DESC NULLS LAST, pdl.updated_at DESC NULLS LAST
    LIMIT 1
    `,
    [playerUid]
  );
  const player = playerResult.rows[0];

  if (!player) {
    throw new Error("player_not_found");
  }

  await tx.query(
    `
    UPDATE players
    SET last_name = $2,
        updated_at = now()
    WHERE player_uid = $1
    `,
    [player.player_uid, player.reset_name]
  );
  await tx.query(
    `
    UPDATE unit_players
    SET roster_name = $2,
        updated_at = now()
    WHERE player_uid = $1
    `,
    [player.player_uid, player.reset_name]
  );
  await insertAudit(tx, actor, "reset_player_name", actor.id, {
    player_uid: player.player_uid,
    reset_name: player.reset_name
  });

  return player;
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/v1/admin/users", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedQuery = usersQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [];
    const where: string[] = [];

    if (parsedQuery.data.q) {
      values.push(`%${parsedQuery.data.q}%`);
      where.push(`(
        au.id::text ILIKE $${values.length}
        OR au.display_name ILIKE $${values.length}
        OR EXISTS (
          SELECT 1 FROM user_identities uiq
          WHERE uiq.user_id = au.id
            AND (uiq.provider_user_id ILIKE $${values.length} OR uiq.display_name ILIKE $${values.length})
        )
      )`);
    }

    if (parsedQuery.data.role) {
      values.push(parsedQuery.data.role);
      where.push(`EXISTS (SELECT 1 FROM user_roles urr WHERE urr.user_id = au.id AND urr.role = $${values.length})`);
    }

    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb<AdminUserRow>(
        `
        SELECT
          au.*,
          COALESCE(array_agg(DISTINCT ur.role) FILTER (WHERE ur.role IS NOT NULL), ARRAY[]::text[]) AS roles,
          COALESCE(
            jsonb_agg(DISTINCT jsonb_build_object(
              'provider', ui.provider,
              'provider_user_id', ui.provider_user_id,
              'display_name', ui.display_name
            )) FILTER (WHERE ui.id IS NOT NULL),
            '[]'::jsonb
          ) AS identities
        FROM app_users au
        LEFT JOIN user_roles ur ON ur.user_id = au.id
        LEFT JOIN user_identities ui ON ui.user_id = au.id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY au.id
        ORDER BY au.created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return { ok: true, users: result.rows.map(serializeUser), pagination: { limit: parsedQuery.data.limit, offset: parsedQuery.data.offset, count: result.rows.length } };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list admin users");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/admin/users/:user_id", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = userParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const userResult = await queryDb<AdminUserRow>(
        `
        SELECT
          au.*,
          COALESCE(array_agg(DISTINCT ur.role) FILTER (WHERE ur.role IS NOT NULL), ARRAY[]::text[]) AS roles,
          COALESCE(
            jsonb_agg(DISTINCT jsonb_build_object(
              'provider', ui.provider,
              'provider_user_id', ui.provider_user_id,
              'display_name', ui.display_name
            )) FILTER (WHERE ui.id IS NOT NULL),
            '[]'::jsonb
          ) AS identities
        FROM app_users au
        LEFT JOIN user_roles ur ON ur.user_id = au.id
        LEFT JOIN user_identities ui ON ui.user_id = au.id
        WHERE au.id = $1
        GROUP BY au.id
        `,
        [parsedParams.data.user_id]
      );
      const user = userResult.rows[0];

      if (!user) {
        return sendNotFound(reply);
      }

      const sessions = await queryDb(
        `
        SELECT id, created_at, expires_at, last_seen_at, revoked_at, user_agent
        FROM user_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
        `,
        [parsedParams.data.user_id]
      );
      const audits = await queryDb(
        `
        SELECT id, actor_user_id, actor_label, action, details, created_at
        FROM admin_audit_events
        WHERE target_user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
        `,
        [parsedParams.data.user_id]
      );

      return { ok: true, user: serializeUser(user), sessions: sessions.rows, audit_events: audits.rows };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch admin user");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.put("/v1/admin/users/:user_id/roles/:role", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = roleParamsSchema.safeParse(request.params);
    const parsedBody = roleBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const actor = await getCurrentUser(request);
    const role = parsedParams.data.role;

    if (!actor || !canManageRole(actor, role)) {
      return sendForbidden(reply, "Only owners may manage owner/admin roles.");
    }

    try {
      await withDbTransaction(async (tx) => {
        if (!(await userExists(tx, parsedParams.data.user_id))) {
          throw new Error("user_not_found");
        }

        await tx.query(
          `
          INSERT INTO user_roles (user_id, role, granted_by_user_id, grant_source)
          VALUES ($1, $2, $3, 'manual')
          ON CONFLICT (user_id, role) DO UPDATE
          SET granted_by_user_id = EXCLUDED.granted_by_user_id,
              grant_source = EXCLUDED.grant_source,
              granted_at = now()
          `,
          [parsedParams.data.user_id, role, actor.id]
        );
        await insertAudit(tx, actor, "grant_role", parsedParams.data.user_id, {
          role,
          reason: parsedBody.data?.reason ?? null
        });
      });

      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === "user_not_found") {
        return sendNotFound(reply);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to grant role");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/admin/users/:user_id/roles/:role", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = roleParamsSchema.safeParse(request.params);
    const parsedBody = roleBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const actor = await getCurrentUser(request);
    const role = parsedParams.data.role;

    if (!actor || !canManageRole(actor, role)) {
      return sendForbidden(reply, "Only owners may manage owner/admin roles.");
    }

    try {
      await withDbTransaction(async (tx) => {
        if (!(await userExists(tx, parsedParams.data.user_id))) {
          throw new Error("user_not_found");
        }

        if (role === "owner" && (await ownerCount(tx)) <= 1) {
          throw new Error("last_owner");
        }

        await tx.query("DELETE FROM user_roles WHERE user_id = $1 AND role = $2", [parsedParams.data.user_id, role]);
        await insertAudit(tx, actor, "revoke_role", parsedParams.data.user_id, {
          role,
          reason: parsedBody.data?.reason ?? null
        });
      });

      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === "user_not_found") {
        return sendNotFound(reply);
      }

      if (error instanceof Error && error.message === "last_owner") {
        return sendForbidden(reply, "Cannot remove the last owner.");
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to revoke role");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/admin/users/:user_id/disable", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = userParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const actor = await getCurrentUser(request);

    if (!actor) {
      return sendForbidden(reply, "Authentication required.");
    }

    try {
      await withDbTransaction(async (tx) => {
        if (!(await userExists(tx, parsedParams.data.user_id))) {
          throw new Error("user_not_found");
        }

        await tx.query("UPDATE app_users SET disabled_at = now(), updated_at = now() WHERE id = $1", [parsedParams.data.user_id]);
        await tx.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
          parsedParams.data.user_id
        ]);
        await insertAudit(tx, actor, "disable_user", parsedParams.data.user_id, {});
      });

      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === "user_not_found") {
        return sendNotFound(reply);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to disable user");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/admin/users/:user_id/enable", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = userParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const actor = await getCurrentUser(request);

    if (!actor) {
      return sendForbidden(reply, "Authentication required.");
    }

    try {
      await withDbTransaction(async (tx) => {
        if (!(await userExists(tx, parsedParams.data.user_id))) {
          throw new Error("user_not_found");
        }

        await tx.query("UPDATE app_users SET disabled_at = NULL, updated_at = now() WHERE id = $1", [
          parsedParams.data.user_id
        ]);
        await insertAudit(tx, actor, "enable_user", parsedParams.data.user_id, {});
      });

      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === "user_not_found") {
        return sendNotFound(reply);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to enable user");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/admin/players/:player_uid/reset-name", async (request, reply) => {
    const parsedParams = playerParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const actor = await getCurrentUser(request);

    if (!actor || !(await canResetPlayerName(actor, parsedParams.data.player_uid))) {
      return sendForbidden(reply, "Only admins and owners may reset player names.");
    }

    try {
      const player = await withDbTransaction((tx) => resetPlayerName(tx, actor, parsedParams.data.player_uid));
      return {
        ok: true,
        player: {
          player_uid: player.player_uid,
          last_name: player.reset_name
        }
      };
    } catch (error) {
      if (error instanceof Error && error.message === "player_not_found") {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "player_not_found",
            message: "Player was not found."
          }
        });
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to reset player name");
      return sendDatabaseUnavailable(reply);
    }
  });
}
