import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { hasRole, requireAdminOrBotToken } from "../auth.js";
import { deny, getAuthContext, type AuthContext } from "../auth/authorization.js";
import { getUserUnitRoles } from "../auth/units.js";
import { evaluateDiscordRoleActions } from "../discord/scoring.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { discordAttendanceRules, discordGuilds, discordRoles, playerDiscordLinks } from "../db/schema/discord.js";
import { players } from "../db/schema/players.js";

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

const playerDiscordLinkReturning = {
  player_uid: playerDiscordLinks.playerUid,
  discord_user_id: playerDiscordLinks.discordUserId,
  discord_username: playerDiscordLinks.discordUsername,
  discord_display_name: playerDiscordLinks.discordDisplayName,
  source: playerDiscordLinks.source,
  verified_at: playerDiscordLinks.verifiedAt,
  raw_link: playerDiscordLinks.rawLink,
  created_at: playerDiscordLinks.createdAt,
  updated_at: playerDiscordLinks.updatedAt
};

const discordAttendanceRuleReturning = {
  id: discordAttendanceRules.id,
  guild_id: discordAttendanceRules.guildId,
  role_id: discordAttendanceRules.roleId,
  name: discordAttendanceRules.name,
  description: discordAttendanceRules.description,
  is_enabled: discordAttendanceRules.isEnabled,
  min_attendance_points: discordAttendanceRules.minAttendancePoints,
  min_operation_count: discordAttendanceRules.minOperationCount,
  min_attendance_percent: discordAttendanceRules.minAttendancePercent,
  lookback_days: discordAttendanceRules.lookbackDays,
  server_key: discordAttendanceRules.serverKey,
  mission_uid_pattern: discordAttendanceRules.missionUidPattern,
  require_present_at_end: discordAttendanceRules.requirePresentAtEnd,
  include_started_operations: discordAttendanceRules.includeStartedOperations,
  grant_mode: discordAttendanceRules.grantMode,
  created_at: discordAttendanceRules.createdAt,
  updated_at: discordAttendanceRules.updatedAt,
  unit_id: discordAttendanceRules.unitId
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

async function guildExists(guildId: string): Promise<boolean> {
  const rows = await getDrizzleDb().select({ guild_id: discordGuilds.guildId }).from(discordGuilds).where(eq(discordGuilds.guildId, guildId)).limit(1);
  return Boolean(rows[0]);
}

async function roleExists(guildId: string, roleId: string): Promise<boolean> {
  const rows = await getDrizzleDb()
    .select({ role_id: discordRoles.roleId })
    .from(discordRoles)
    .where(and(eq(discordRoles.guildId, guildId), eq(discordRoles.roleId, roleId), eq(discordRoles.isDeleted, false)))
    .limit(1);
  return Boolean(rows[0]);
}

async function playerExists(playerUid: string): Promise<boolean> {
  const rows = await getDrizzleDb().select({ player_uid: players.playerUid }).from(players).where(eq(players.playerUid, playerUid)).limit(1);
  return Boolean(rows[0]);
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
      const db = getDrizzleDb();
      const deletedCount = await db.transaction(async (tx) => {
        await tx
          .insert(discordGuilds)
          .values({
            guildId: guild.guild_id,
            name: guild.name,
            iconUrl: guild.icon_url ?? null,
            botUserId: guild.bot_user_id ?? null,
            botPresent: guild.bot_present ?? true,
            lastRoleSyncAt: sql`now()`,
            rawGuild: guild
          })
          .onConflictDoUpdate({
            target: discordGuilds.guildId,
            set: {
              name: sql`excluded.name`,
              iconUrl: sql`excluded.icon_url`,
              botUserId: sql`excluded.bot_user_id`,
              botPresent: sql`excluded.bot_present`,
              lastRoleSyncAt: sql`now()`,
              rawGuild: sql`excluded.raw_guild`,
              updatedAt: sql`now()`
            }
          });

        for (const role of roles) {
          await tx
            .insert(discordRoles)
            .values({
              guildId: guild.guild_id,
              roleId: role.role_id,
              name: role.name,
              color: role.color ?? null,
              position: role.position ?? null,
              managed: role.managed ?? false,
              assignable: role.assignable ?? true,
              isDeleted: false,
              lastSeenAt: sql`now()`,
              rawRole: role
            })
            .onConflictDoUpdate({
              target: [discordRoles.guildId, discordRoles.roleId],
              set: {
                name: sql`excluded.name`,
                color: sql`excluded.color`,
                position: sql`excluded.position`,
                managed: sql`excluded.managed`,
                assignable: sql`excluded.assignable`,
                isDeleted: false,
                lastSeenAt: sql`now()`,
                rawRole: sql`excluded.raw_role`,
                updatedAt: sql`now()`
              }
            });
        }

        const roleIds = roles.map((role) => role.role_id);
        const deletedRoles =
          roleIds.length === 0
            ? await tx
                .update(discordRoles)
                .set({ isDeleted: true, updatedAt: sql`now()` })
                .where(and(eq(discordRoles.guildId, guild.guild_id), eq(discordRoles.isDeleted, false)))
                .returning({ role_id: discordRoles.roleId })
            : await tx
                .update(discordRoles)
                .set({ isDeleted: true, updatedAt: sql`now()` })
                .where(and(eq(discordRoles.guildId, guild.guild_id), eq(discordRoles.isDeleted, false), notInArray(discordRoles.roleId, roleIds)))
                .returning({ role_id: discordRoles.roleId });

        return deletedRoles.length;
      });

      return {
        ok: true,
        guild_id: guild.guild_id,
        roles_seen: roles.length,
        roles_upserted: roles.length,
        roles_marked_deleted: deletedCount
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
      const result = await getDrizzleDb().execute(sql`
        SELECT *
        FROM discord_roles
        WHERE guild_id = ${parsedParams.data.guild_id}
        ORDER BY position DESC NULLS LAST, name ASC
      `);

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

    try {
      const search = parsedQuery.data.q?.trim();
      const result = await getDrizzleDb().execute(sql`
        SELECT pdl.*, p.last_name AS player_name
        FROM player_discord_links pdl
        JOIN players p ON p.player_uid = pdl.player_uid
        ${
          search
            ? sql`WHERE (p.player_uid ILIKE ${`%${search}%`} OR p.last_name ILIKE ${`%${search}%`} OR pdl.discord_user_id ILIKE ${`%${search}%`} OR pdl.discord_display_name ILIKE ${`%${search}%`})`
            : sql``
        }
        ORDER BY pdl.updated_at DESC
        LIMIT ${parsedQuery.data.limit} OFFSET ${parsedQuery.data.offset}
      `);

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

      const result = await getDrizzleDb()
        .insert(playerDiscordLinks)
        .values({
          playerUid: body.player_uid,
          discordUserId: body.discord_user_id,
          discordUsername: body.discord_username ?? null,
          discordDisplayName: body.discord_display_name ?? null,
          source: body.source,
          verifiedAt: body.verified ? sql`now()` : null,
          rawLink: body.raw_link ?? body
        })
        .onConflictDoUpdate({
          target: playerDiscordLinks.discordUserId,
          set: {
            playerUid: sql`excluded.player_uid`,
            discordUsername: sql`excluded.discord_username`,
            discordDisplayName: sql`excluded.discord_display_name`,
            source: sql`excluded.source`,
            verifiedAt: sql`COALESCE(excluded.verified_at, ${playerDiscordLinks.verifiedAt})`,
            rawLink: sql`excluded.raw_link`,
            updatedAt: sql`now()`
          }
        })
        .returning(playerDiscordLinkReturning);

      return { ok: true, link: result[0] };
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
      const result = await getDrizzleDb()
        .delete(playerDiscordLinks)
        .where(eq(playerDiscordLinks.discordUserId, parsedParams.data.discord_user_id))
        .returning({ discord_user_id: playerDiscordLinks.discordUserId });
      return { ok: true, deleted: result.length };
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
      const result = await getDrizzleDb().execute(sql`
        SELECT dar.*, dr.name AS role_name
        FROM discord_attendance_rules dar
        JOIN discord_roles dr ON dr.guild_id = dar.guild_id AND dr.role_id = dar.role_id
        WHERE dar.guild_id = ${parsedParams.data.guild_id}
        ORDER BY dar.created_at DESC
      `);
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

      const result = await getDrizzleDb()
        .insert(discordAttendanceRules)
        .values({
          guildId,
          roleId: body.role_id,
          name: body.name,
          description: body.description ?? null,
          isEnabled: body.is_enabled,
          minAttendancePoints: body.min_attendance_points,
          minOperationCount: body.min_operation_count,
          minAttendancePercent: body.min_attendance_percent === undefined ? null : String(body.min_attendance_percent),
          lookbackDays: body.lookback_days ?? null,
          serverKey: body.server_key ?? null,
          missionUidPattern: body.mission_uid_pattern ?? null,
          requirePresentAtEnd: body.require_present_at_end,
          includeStartedOperations: body.include_started_operations,
          grantMode: body.grant_mode
        })
        .returning(discordAttendanceRuleReturning);

      return { ok: true, rule: result[0] };
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
      const currentResult = await getDrizzleDb()
        .select({
          id: discordAttendanceRules.id,
          guild_id: discordAttendanceRules.guildId,
          role_id: discordAttendanceRules.roleId,
          name: discordAttendanceRules.name,
          description: discordAttendanceRules.description,
          is_enabled: discordAttendanceRules.isEnabled,
          min_attendance_points: discordAttendanceRules.minAttendancePoints,
          min_operation_count: discordAttendanceRules.minOperationCount,
          min_attendance_percent: discordAttendanceRules.minAttendancePercent,
          lookback_days: discordAttendanceRules.lookbackDays,
          server_key: discordAttendanceRules.serverKey,
          mission_uid_pattern: discordAttendanceRules.missionUidPattern,
          require_present_at_end: discordAttendanceRules.requirePresentAtEnd,
          include_started_operations: discordAttendanceRules.includeStartedOperations,
          grant_mode: discordAttendanceRules.grantMode
        })
        .from(discordAttendanceRules)
        .where(and(eq(discordAttendanceRules.guildId, guildId), eq(discordAttendanceRules.id, ruleId)))
        .limit(1);
      const current = currentResult[0] as Record<string, unknown> | undefined;

      if (!current) {
        return reply.code(404).send({ ok: false, error: { code: "rule_not_found", message: "Discord attendance rule was not found." } });
      }

      const merged = { ...current, ...parsedBody.data };
      const nextRoleId = String(merged.role_id);

      if (!(await roleExists(guildId, nextRoleId))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const result = await getDrizzleDb()
        .update(discordAttendanceRules)
        .set({
          roleId: nextRoleId,
          name: String(merged.name),
          description: merged.description === undefined ? null : String(merged.description),
          isEnabled: Boolean(merged.is_enabled),
          minAttendancePoints: Number(merged.min_attendance_points),
          minOperationCount: Number(merged.min_operation_count),
          minAttendancePercent: merged.min_attendance_percent === undefined || merged.min_attendance_percent === null ? null : String(merged.min_attendance_percent),
          lookbackDays: merged.lookback_days === undefined || merged.lookback_days === null ? null : Number(merged.lookback_days),
          serverKey: merged.server_key === undefined || merged.server_key === null ? null : String(merged.server_key),
          missionUidPattern: merged.mission_uid_pattern === undefined || merged.mission_uid_pattern === null ? null : String(merged.mission_uid_pattern),
          requirePresentAtEnd: Boolean(merged.require_present_at_end),
          includeStartedOperations: Boolean(merged.include_started_operations),
          grantMode: String(merged.grant_mode),
          updatedAt: sql`now()`
        })
        .where(and(eq(discordAttendanceRules.guildId, guildId), eq(discordAttendanceRules.id, ruleId)))
        .returning(discordAttendanceRuleReturning);

      return { ok: true, rule: result[0] };
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
      const result = await getDrizzleDb()
        .delete(discordAttendanceRules)
        .where(and(eq(discordAttendanceRules.guildId, parsedParams.data.guild_id), eq(discordAttendanceRules.id, parsedParams.data.rule_id)))
        .returning({ id: discordAttendanceRules.id });
      return { ok: true, deleted: result.length };
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
