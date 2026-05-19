import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { hasRole, requireAdminOrBotToken } from "../auth.js";
import { deny, getAuthContext, type AuthContext } from "../auth/authorization.js";
import { getUserUnitRoles } from "../auth/units.js";
import { evaluateDiscordRoleActions } from "../discord/scoring.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";

const guildSyncSchema = z.object({
  guild: z
    .object({
      guild_id: z.string().min(1).max(64),
      name: z.string().min(1).max(200),
      icon_url: z.string().url().optional(),
      bot_user_id: z.string().min(1).max(64).optional(),
      bot_present: z.boolean().optional()
    })
    .passthrough(),
  roles: z.array(
    z
      .object({
        role_id: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        color: z.number().int().optional(),
        position: z.number().int().optional(),
        managed: z.boolean().optional(),
        assignable: z.boolean().optional()
      })
      .passthrough()
  )
});

const guildParamsSchema = z.object({
  guild_id: z.string().min(1).max(64)
});

const ruleParamsSchema = guildParamsSchema.extend({
  rule_id: z.string().uuid()
});

const linkParamsSchema = z.object({
  discord_user_id: z.string().min(1).max(64)
});

const playerLinksQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const playerLinkBodySchema = z.object({
  player_uid: z.string().min(1).max(200),
  discord_user_id: z.string().min(1).max(64),
  discord_username: z.string().max(200).optional(),
  discord_display_name: z.string().max(200).optional(),
  source: z.enum(["manual", "bot", "import"]).default("manual"),
  verified: z.boolean().optional(),
  raw_link: z.record(z.string(), z.unknown()).optional()
});

const ruleBodySchema = z.object({
  role_id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  is_enabled: z.boolean().default(true),
  min_attendance_points: z.number().int().min(0).default(0),
  min_operation_count: z.number().int().min(0).default(0),
  min_attendance_percent: z.number().min(0).max(100).nullable().optional(),
  lookback_days: z.number().int().min(1).nullable().optional(),
  server_key: z.string().max(128).nullable().optional(),
  mission_uid_pattern: z.string().max(200).nullable().optional(),
  require_present_at_end: z.boolean().default(false),
  include_started_operations: z.boolean().default(false),
  grant_mode: z.enum(["grant_only", "grant_and_revoke_preview"]).default("grant_only")
});

const rulePatchSchema = ruleBodySchema.partial();

const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .or(z.boolean());

const roleActionsQuerySchema = z.object({
  dry_run: queryBooleanSchema.default(true),
  persist: queryBooleanSchema.default(false)
});

const roleActionResultsBodySchema = z.object({
  evaluation_id: z.string().uuid(),
  results: z.array(
    z.object({
      audit_id: z.string().uuid().optional(),
      action: z.enum(["grant", "revoke_preview", "skip"]),
      player_uid: z.string().max(200).optional(),
      discord_user_id: z.string().max(64).optional(),
      role_id: z.string().min(1).max(64),
      status: z.enum(["reported_success", "reported_failure", "skipped"]),
      error_message: z.string().max(1000).nullable().optional()
    })
  )
});

const auditsQuerySchema = z.object({
  evaluation_id: z.string().uuid().optional(),
  player_uid: z.string().max(200).optional(),
  discord_user_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

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

async function guildExists(guildId: string): Promise<boolean> {
  const result = await queryDb<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM discord_guilds WHERE guild_id = $1) AS exists", [
    guildId
  ]);
  return result.rows[0]?.exists ?? false;
}

async function roleExists(guildId: string, roleId: string): Promise<boolean> {
  const result = await queryDb<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM discord_roles WHERE guild_id = $1 AND role_id = $2 AND is_deleted = false) AS exists",
    [guildId, roleId]
  );
  return result.rows[0]?.exists ?? false;
}

async function playerExists(playerUid: string): Promise<boolean> {
  const result = await queryDb<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM players WHERE player_uid = $1) AS exists", [
    playerUid
  ]);
  return result.rows[0]?.exists ?? false;
}

async function requireAnyDiscordAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  allowBotToken = false
): Promise<AuthContext | null> {
  const auth = await getAuthContext(request, reply, { allowBotToken, allowMachineToken: true });

  if (!auth) {
    return null;
  }

  if (auth.kind === "machine") {
    return auth;
  }

  if (hasRole(auth.user, ["admin"])) {
    return auth;
  }

  const unitRoles = await getUserUnitRoles(auth.user.id);

  if (unitRoles.some((role) => role.role === "admin")) {
    return auth;
  }

  deny(reply);
  return null;
}

export async function registerDiscordRoutes(app: FastifyInstance) {
  app.post("/v1/discord/guilds/sync", { preHandler: requireAdminOrBotToken }, async (request, reply) => {
    const parsed = guildSyncSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const { guild, roles } = parsed.data;

    try {
      await queryDb(
        `
        INSERT INTO discord_guilds (
          guild_id, name, icon_url, bot_user_id, bot_present, last_role_sync_at, raw_guild
        )
        VALUES ($1, $2, $3, $4, $5, now(), $6::jsonb)
        ON CONFLICT (guild_id) DO UPDATE
        SET
          name = EXCLUDED.name,
          icon_url = EXCLUDED.icon_url,
          bot_user_id = EXCLUDED.bot_user_id,
          bot_present = EXCLUDED.bot_present,
          last_role_sync_at = now(),
          raw_guild = EXCLUDED.raw_guild,
          updated_at = now()
        `,
        [
          guild.guild_id,
          guild.name,
          guild.icon_url ?? null,
          guild.bot_user_id ?? null,
          guild.bot_present ?? true,
          JSON.stringify(guild)
        ]
      );

      for (const role of roles) {
        await queryDb(
          `
          INSERT INTO discord_roles (
            guild_id, role_id, name, color, position, managed, assignable, is_deleted, last_seen_at, raw_role
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, false, now(), $8::jsonb)
          ON CONFLICT (guild_id, role_id) DO UPDATE
          SET
            name = EXCLUDED.name,
            color = EXCLUDED.color,
            position = EXCLUDED.position,
            managed = EXCLUDED.managed,
            assignable = EXCLUDED.assignable,
            is_deleted = false,
            last_seen_at = now(),
            raw_role = EXCLUDED.raw_role,
            updated_at = now()
          `,
          [
            guild.guild_id,
            role.role_id,
            role.name,
            role.color ?? null,
            role.position ?? null,
            role.managed ?? false,
            role.assignable ?? true,
            JSON.stringify(role)
          ]
        );
      }

      const roleIds = roles.map((role) => role.role_id);
      const deletedResult = await queryDb<{ count: number }>(
        `
        UPDATE discord_roles
        SET is_deleted = true, updated_at = now()
        WHERE guild_id = $1
          AND NOT (role_id = ANY($2::text[]))
          AND is_deleted = false
        RETURNING role_id
        `,
        [guild.guild_id, roleIds]
      );

      return {
        ok: true,
        guild_id: guild.guild_id,
        roles_seen: roles.length,
        roles_upserted: roles.length,
        roles_marked_deleted: deletedResult.rowCount ?? 0
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to sync Discord guild");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    try {
      const result = await queryDb(
        `
        SELECT
          dg.*,
          COUNT(DISTINCT dr.role_id)::int AS role_count,
          COUNT(DISTINCT pdl.discord_user_id)::int AS linked_player_count,
          COUNT(DISTINCT dar.id) FILTER (WHERE dar.is_enabled = true)::int AS enabled_rule_count
        FROM discord_guilds dg
        LEFT JOIN discord_roles dr ON dr.guild_id = dg.guild_id AND dr.is_deleted = false
        LEFT JOIN player_discord_links pdl ON true
        LEFT JOIN discord_attendance_rules dar ON dar.guild_id = dg.guild_id
        GROUP BY dg.guild_id
        ORDER BY dg.updated_at DESC
        `
      );

      return { ok: true, guilds: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await queryDb(
        `
        SELECT
          dg.*,
          COUNT(DISTINCT dr.role_id)::int AS role_count,
          COUNT(DISTINCT pdl.discord_user_id)::int AS linked_player_count,
          COUNT(DISTINCT dar.id) FILTER (WHERE dar.is_enabled = true)::int AS enabled_rule_count
        FROM discord_guilds dg
        LEFT JOIN discord_roles dr ON dr.guild_id = dg.guild_id AND dr.is_deleted = false
        LEFT JOIN player_discord_links pdl ON true
        LEFT JOIN discord_attendance_rules dar ON dar.guild_id = dg.guild_id
        WHERE dg.guild_id = $1
        GROUP BY dg.guild_id
        `,
        [parsedParams.data.guild_id]
      );

      const guild = result.rows[0];

      if (!guild) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      return { ok: true, guild };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id/roles", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await queryDb(
        `
        SELECT *
        FROM discord_roles
        WHERE guild_id = $1
        ORDER BY position DESC NULLS LAST, name ASC
        `,
        [parsedParams.data.guild_id]
      );

      return { ok: true, roles: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/player-links", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedQuery = playerLinksQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [];
    const where: string[] = [];

    if (parsedQuery.data.q) {
      values.push(`%${parsedQuery.data.q}%`);
      where.push(`(p.player_uid ILIKE $${values.length} OR p.last_name ILIKE $${values.length} OR pdl.discord_user_id ILIKE $${values.length} OR pdl.discord_display_name ILIKE $${values.length})`);
    }

    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb(
        `
        SELECT pdl.*, p.last_name AS player_name
        FROM player_discord_links pdl
        JOIN players p ON p.player_uid = pdl.player_uid
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY pdl.updated_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return { ok: true, links: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/player-links", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsed = playerLinkBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const body = parsed.data;

    try {
      if (!(await playerExists(body.player_uid))) {
        return reply.code(404).send({ ok: false, error: { code: "player_not_found", message: "Player was not found." } });
      }

      const result = await queryDb(
        `
        INSERT INTO player_discord_links (
          player_uid, discord_user_id, discord_username, discord_display_name, source, verified_at, raw_link
        )
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() ELSE NULL END, $7::jsonb)
        ON CONFLICT (discord_user_id) DO UPDATE
        SET
          player_uid = EXCLUDED.player_uid,
          discord_username = EXCLUDED.discord_username,
          discord_display_name = EXCLUDED.discord_display_name,
          source = EXCLUDED.source,
          verified_at = COALESCE(EXCLUDED.verified_at, player_discord_links.verified_at),
          raw_link = EXCLUDED.raw_link,
          updated_at = now()
        RETURNING *
        `,
        [
          body.player_uid,
          body.discord_user_id,
          body.discord_username ?? null,
          body.discord_display_name ?? null,
          body.source,
          body.verified ?? false,
          JSON.stringify(body.raw_link ?? body)
        ]
      );

      return { ok: true, link: result.rows[0] };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to upsert Discord player link");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/discord/player-links/:discord_user_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = linkParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await queryDb("DELETE FROM player_discord_links WHERE discord_user_id = $1", [
        parsedParams.data.discord_user_id
      ]);
      return { ok: true, deleted: result.rowCount ?? 0 };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id/rules", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await queryDb(
        `
        SELECT dar.*, dr.name AS role_name
        FROM discord_attendance_rules dar
        JOIN discord_roles dr ON dr.guild_id = dar.guild_id AND dr.role_id = dar.role_id
        WHERE dar.guild_id = $1
        ORDER BY dar.created_at DESC
        `,
        [parsedParams.data.guild_id]
      );
      return { ok: true, rules: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/rules", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = ruleBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;
    const body = parsedBody.data;

    try {
      if (!(await guildExists(guildId))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      if (!(await roleExists(guildId, body.role_id))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const result = await queryDb(
        `
        INSERT INTO discord_attendance_rules (
          guild_id, role_id, name, description, is_enabled, min_attendance_points,
          min_operation_count, min_attendance_percent, lookback_days, server_key,
          mission_uid_pattern, require_present_at_end, include_started_operations, grant_mode
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *
        `,
        [
          guildId,
          body.role_id,
          body.name,
          body.description ?? null,
          body.is_enabled,
          body.min_attendance_points,
          body.min_operation_count,
          body.min_attendance_percent ?? null,
          body.lookback_days ?? null,
          body.server_key ?? null,
          body.mission_uid_pattern ?? null,
          body.require_present_at_end,
          body.include_started_operations,
          body.grant_mode
        ]
      );

      return { ok: true, rule: result.rows[0] };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create Discord attendance rule");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/discord/guilds/:guild_id/rules/:rule_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = ruleParamsSchema.safeParse(request.params);
    const parsedBody = rulePatchSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;
    const ruleId = parsedParams.data.rule_id;

    try {
      const currentResult = await queryDb("SELECT * FROM discord_attendance_rules WHERE guild_id = $1 AND id = $2", [guildId, ruleId]);
      const current = currentResult.rows[0] as Record<string, unknown> | undefined;

      if (!current) {
        return reply.code(404).send({ ok: false, error: { code: "rule_not_found", message: "Discord attendance rule was not found." } });
      }

      const merged = { ...current, ...parsedBody.data };
      const nextRoleId = String(merged.role_id);

      if (!(await roleExists(guildId, nextRoleId))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const result = await queryDb(
        `
        UPDATE discord_attendance_rules
        SET
          role_id = $3,
          name = $4,
          description = $5,
          is_enabled = $6,
          min_attendance_points = $7,
          min_operation_count = $8,
          min_attendance_percent = $9,
          lookback_days = $10,
          server_key = $11,
          mission_uid_pattern = $12,
          require_present_at_end = $13,
          include_started_operations = $14,
          grant_mode = $15,
          updated_at = now()
        WHERE guild_id = $1 AND id = $2
        RETURNING *
        `,
        [
          guildId,
          ruleId,
          nextRoleId,
          merged.name,
          merged.description ?? null,
          merged.is_enabled,
          merged.min_attendance_points,
          merged.min_operation_count,
          merged.min_attendance_percent ?? null,
          merged.lookback_days ?? null,
          merged.server_key ?? null,
          merged.mission_uid_pattern ?? null,
          merged.require_present_at_end,
          merged.include_started_operations,
          merged.grant_mode
        ]
      );

      return { ok: true, rule: result.rows[0] };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update Discord attendance rule");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/discord/guilds/:guild_id/rules/:rule_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = ruleParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await queryDb("DELETE FROM discord_attendance_rules WHERE guild_id = $1 AND id = $2", [
        parsedParams.data.guild_id,
        parsedParams.data.rule_id
      ]);
      return { ok: true, deleted: result.rowCount ?? 0 };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id/role-actions", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedQuery = roleActionsQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    try {
      if (!(await guildExists(parsedParams.data.guild_id))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      const evaluation = await evaluateDiscordRoleActions(parsedParams.data.guild_id, parsedQuery.data.persist);

      return {
        ok: true,
        guild_id: parsedParams.data.guild_id,
        evaluation_id: evaluation.evaluation_id,
        dry_run: parsedQuery.data.dry_run,
        actions: evaluation.actions,
        skipped: evaluation.skipped,
        summary: evaluation.summary
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to evaluate Discord role actions");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/role-action-results", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = roleActionResultsBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    let updated = 0;
    let failedToMatch = 0;

    try {
      for (const result of parsedBody.data.results) {
        const values = [
          parsedParams.data.guild_id,
          parsedBody.data.evaluation_id,
          result.audit_id ?? null,
          result.player_uid ?? null,
          result.discord_user_id ?? null,
          result.role_id,
          result.action,
          result.status,
          result.error_message ?? null
        ];
        const updateResult = await queryDb(
          `
          UPDATE discord_role_action_audits
          SET status = $8, error_message = $9, reported_at = now()
          WHERE guild_id = $1
            AND evaluation_id = $2
            AND ($3::uuid IS NULL OR id = $3::uuid)
            AND ($4::text IS NULL OR player_uid = $4)
            AND ($5::text IS NULL OR discord_user_id = $5)
            AND role_id = $6
            AND action = $7
          `,
          values
        );

        if ((updateResult.rowCount ?? 0) > 0) {
          updated += updateResult.rowCount ?? 0;
        } else {
          failedToMatch += 1;
        }
      }

      return { ok: true, updated, failed_to_match: failedToMatch };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to report Discord role action results");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id/role-action-audits", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedQuery = auditsQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [parsedParams.data.guild_id];
    const where = ["guild_id = $1"];

    if (parsedQuery.data.evaluation_id) {
      values.push(parsedQuery.data.evaluation_id);
      where.push(`evaluation_id = $${values.length}`);
    }

    if (parsedQuery.data.player_uid) {
      values.push(parsedQuery.data.player_uid);
      where.push(`player_uid = $${values.length}`);
    }

    if (parsedQuery.data.discord_user_id) {
      values.push(parsedQuery.data.discord_user_id);
      where.push(`discord_user_id = $${values.length}`);
    }

    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb(
        `
        SELECT *
        FROM discord_role_action_audits
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return { ok: true, audits: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });
}
