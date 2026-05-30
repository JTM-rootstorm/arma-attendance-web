import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, not, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { hasRole, requireAdminOrBotToken } from "../auth.js";
import { deny, getAuthContext, type AuthContext } from "../auth/authorization.js";
import { getUserUnitRoles } from "../auth/units.js";
import { getDiscordAuthPolicy } from "../config/discordAuth.js";
import {
  reconcileDiscordMembership,
  syncDiscordAuthPolicyToDb,
  upsertDiscordMemberSnapshot
} from "../discord/membershipResolver.js";
import { evaluateDiscordRoleActions } from "../discord/scoring.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import {
  discordAttendanceRules,
  discordGuilds,
  discordMemberSnapshots,
  discordRoleMappings,
  discordRoles,
  playerDiscordLinks
} from "../db/schema/discord.js";
import { players } from "../db/schema/players.js";
import { unitDiscordGuilds, units } from "../db/schema/units.js";

type DrizzleDb = ReturnType<typeof getDrizzleDb>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

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

const roleBodySchema = z.object({
  role_id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  unit_id: z.string().uuid().nullable().optional(),
  priority: z.number().int().default(0),
  assignable: z.boolean().default(true)
});

const roleParamsSchema = guildParamsSchema.extend({
  role_id: z.string().min(1).max(64)
});

const ruleParamsSchema = guildParamsSchema.extend({
  rule_id: z.string().uuid()
});

const roleMappingParamsSchema = guildParamsSchema.extend({
  mapping_id: z.string().uuid()
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

const guildAuthPolicyBodySchema = z.object({
  guild_type: z.enum(["fallback", "partner", "internal", "unknown"]).default("unknown"),
  grants_login: z.boolean().default(false),
  sync_members: z.boolean().default(false),
  is_fallback: z.boolean().default(false),
  unit_priority: z.number().int().default(0),
  rank_priority: z.number().int().default(0),
  permission_priority: z.number().int().default(0),
  config_order: z.number().int().default(1000)
});

const mappingCommonSchema = {
  role_id: z.string().min(1).max(64),
  priority: z.number().int().default(0),
  is_enabled: z.boolean().default(true),
  notes: z.string().max(1000).nullable().optional()
};

const roleMappingBodySchema = z.discriminatedUnion("mapping_type", [
  z.object({ ...mappingCommonSchema, mapping_type: z.literal("unit_primary"), unit_id: z.string().uuid() }).strict(),
  z.object({ ...mappingCommonSchema, mapping_type: z.literal("unit_secondary"), unit_id: z.string().uuid() }).strict(),
  z.object({ ...mappingCommonSchema, mapping_type: z.literal("rank"), rank_id: z.string().uuid(), unit_id: z.string().uuid().optional() }).strict(),
  z.object({
    ...mappingCommonSchema,
    mapping_type: z.literal("unit_role"),
    unit_id: z.string().uuid(),
    unit_role: z.enum(["member", "officer", "admin", "tcw_admin"])
  }).strict(),
  z.object({
    ...mappingCommonSchema,
    mapping_type: z.literal("app_role"),
    app_role: z.enum(["viewer", "officer", "admin", "tcw_admin", "owner"])
  }).strict(),
  z.object({
    ...mappingCommonSchema,
    mapping_type: z.literal("roster_status"),
    roster_status: z.enum(["active", "reserve", "loa", "inactive"]),
    unit_id: z.string().uuid().optional()
  }).strict(),
  z.object({ ...mappingCommonSchema, mapping_type: z.literal("deny_login") }).strict()
]);

const roleMappingPatchSchema = z
  .object({
    role_id: z.string().min(1).max(64).optional(),
    mapping_type: z.enum(["unit_primary", "unit_secondary", "rank", "unit_role", "app_role", "roster_status", "deny_login"]).optional(),
    unit_id: z.string().uuid().nullable().optional(),
    rank_id: z.string().uuid().nullable().optional(),
    unit_role: z.enum(["member", "officer", "admin", "tcw_admin"]).nullable().optional(),
    app_role: z.enum(["viewer", "officer", "admin", "tcw_admin", "owner"]).nullable().optional(),
    roster_status: z.enum(["active", "reserve", "loa", "inactive"]).nullable().optional(),
    priority: z.number().int().optional(),
    is_enabled: z.boolean().optional(),
    notes: z.string().max(1000).nullable().optional()
  })
  .strict();

const memberSnapshotBodySchema = z.object({
  members: z.array(
    z.object({
      discord_user_id: z.string().min(1).max(64),
      roles: z.array(z.string().min(1).max(64)).default([]),
      nick: z.string().max(200).nullable().optional(),
      joined_at: z.string().datetime().nullable().optional(),
      raw_member: z.record(z.string(), z.unknown()).optional()
    })
  ),
  reconcile: z.boolean().default(false)
});

const memberSnapshotQuerySchema = z.object({
  discord_user_id: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

const reconcileBodySchema = z
  .object({
    discord_user_id: z.string().min(1).max(64).optional(),
    user_id: z.string().uuid().optional(),
    guild_id: z.string().min(1).max(64).optional(),
    dry_run: z.boolean().default(true)
  })
  .refine((body) => body.discord_user_id || body.user_id, {
    message: "discord_user_id or user_id is required."
  });

const assignmentAuditsQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
  player_uid: z.string().max(200).optional(),
  discord_user_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

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

const discordRoleMappingReturning = {
  id: discordRoleMappings.id,
  guild_id: discordRoleMappings.guildId,
  role_id: discordRoleMappings.roleId,
  mapping_type: discordRoleMappings.mappingType,
  unit_id: discordRoleMappings.unitId,
  rank_id: discordRoleMappings.rankId,
  unit_role: discordRoleMappings.unitRole,
  app_role: discordRoleMappings.appRole,
  roster_status: discordRoleMappings.rosterStatus,
  priority: discordRoleMappings.priority,
  is_enabled: discordRoleMappings.isEnabled,
  notes: discordRoleMappings.notes,
  created_at: discordRoleMappings.createdAt,
  updated_at: discordRoleMappings.updatedAt
};

type RoleMappingInput = z.infer<typeof roleMappingBodySchema>;
type RoleMappingPatch = z.infer<typeof roleMappingPatchSchema>;

type RoleMappingDbValues = {
  guildId: string;
  roleId: string;
  mappingType: RoleMappingInput["mapping_type"];
  unitId: string | null;
  rankId: string | null;
  unitRole: string | null;
  appRole: string | null;
  rosterStatus: string | null;
  priority: number;
  isEnabled: boolean;
  notes: string | null;
};

type RoleMappingRow = {
  id: string;
  role_id: string;
  mapping_type: RoleMappingInput["mapping_type"];
  unit_id: string | null;
  rank_id: string | null;
  unit_role: string | null;
  app_role: string | null;
  roster_status: string | null;
  priority: number;
  is_enabled: boolean;
  notes: string | null;
};

type UnitRoleMappingRole = "member" | "officer" | "admin" | "tcw_admin";
type AppRoleMappingRole = "viewer" | "officer" | "admin" | "tcw_admin" | "owner";
type RosterStatusMappingStatus = "active" | "reserve" | "loa" | "inactive";

function roleMappingInputToDbValues(guildId: string, input: RoleMappingInput): RoleMappingDbValues {
  return {
    guildId,
    roleId: input.role_id,
    mappingType: input.mapping_type,
    unitId: "unit_id" in input ? input.unit_id ?? null : null,
    rankId: "rank_id" in input ? input.rank_id ?? null : null,
    unitRole: "unit_role" in input ? input.unit_role ?? null : null,
    appRole: "app_role" in input ? input.app_role ?? null : null,
    rosterStatus: "roster_status" in input ? input.roster_status ?? null : null,
    priority: input.priority,
    isEnabled: input.is_enabled,
    notes: input.notes ?? null
  };
}

function roleMappingRowToInput(row: RoleMappingRow): RoleMappingInput {
  const base = {
    role_id: row.role_id,
    priority: row.priority,
    is_enabled: row.is_enabled,
    notes: row.notes
  };

  switch (row.mapping_type) {
    case "unit_primary":
    case "unit_secondary":
      return { ...base, mapping_type: row.mapping_type, unit_id: row.unit_id ?? "" };
    case "rank":
      return {
        ...base,
        mapping_type: "rank",
        rank_id: row.rank_id ?? "",
        ...(row.unit_id ? { unit_id: row.unit_id } : {})
      };
    case "unit_role":
      return { ...base, mapping_type: "unit_role", unit_id: row.unit_id ?? "", unit_role: row.unit_role as UnitRoleMappingRole };
    case "app_role":
      return { ...base, mapping_type: "app_role", app_role: row.app_role as AppRoleMappingRole };
    case "roster_status":
      return {
        ...base,
        mapping_type: "roster_status",
        roster_status: row.roster_status as RosterStatusMappingStatus,
        ...(row.unit_id ? { unit_id: row.unit_id } : {})
      };
    case "deny_login":
      return { ...base, mapping_type: "deny_login" };
  }
}

function mergeRoleMappingPatch(current: RoleMappingInput, patch: RoleMappingPatch) {
  const merged = { ...current, ...patch };
  const base = {
    role_id: merged.role_id,
    mapping_type: merged.mapping_type,
    priority: merged.priority,
    is_enabled: merged.is_enabled,
    notes: merged.notes
  };

  switch (merged.mapping_type) {
    case "unit_primary":
    case "unit_secondary":
      return { ...base, unit_id: merged.unit_id };
    case "rank":
      return {
        ...base,
        rank_id: merged.rank_id,
        ...(merged.unit_id ? { unit_id: merged.unit_id } : {})
      };
    case "unit_role":
      return { ...base, unit_id: merged.unit_id, unit_role: merged.unit_role };
    case "app_role":
      return { ...base, app_role: merged.app_role };
    case "roster_status":
      return {
        ...base,
        roster_status: merged.roster_status,
        ...(merged.unit_id ? { unit_id: merged.unit_id } : {})
      };
    case "deny_login":
      return base;
  }
}

function sameNullableColumn(column: Parameters<typeof isNull>[0], value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

async function findExistingRoleMapping(tx: DrizzleTransaction, values: RoleMappingDbValues, exceptId?: string) {
  const rows = await tx
    .select({ id: discordRoleMappings.id })
    .from(discordRoleMappings)
    .where(
      and(
        eq(discordRoleMappings.guildId, values.guildId),
        eq(discordRoleMappings.roleId, values.roleId),
        eq(discordRoleMappings.mappingType, values.mappingType),
        sameNullableColumn(discordRoleMappings.unitId, values.unitId),
        sameNullableColumn(discordRoleMappings.rankId, values.rankId),
        sameNullableColumn(discordRoleMappings.unitRole, values.unitRole),
        sameNullableColumn(discordRoleMappings.appRole, values.appRole),
        sameNullableColumn(discordRoleMappings.rosterStatus, values.rosterStatus),
        exceptId ? not(eq(discordRoleMappings.id, exceptId)) : undefined
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

async function upsertDiscordRoleMapping(tx: DrizzleTransaction, guildId: string, input: RoleMappingInput) {
  const values = roleMappingInputToDbValues(guildId, input);
  const existing = await findExistingRoleMapping(tx, values);

  if (existing) {
    const [mapping] = await tx
      .update(discordRoleMappings)
      .set({
        priority: values.priority,
        isEnabled: values.isEnabled,
        notes: values.notes,
        updatedAt: sql`now()`
      })
      .where(eq(discordRoleMappings.id, existing.id))
      .returning(discordRoleMappingReturning);

    return mapping;
  }

  const [mapping] = await tx
    .insert(discordRoleMappings)
    .values(values)
    .returning(discordRoleMappingReturning);

  return mapping;
}

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
  const rows = await getDrizzleDb()
    .select({ player_uid: players.playerUid })
    .from(players)
    .where(and(eq(players.playerUid, playerUid), isNull(players.deletedAt)))
    .limit(1);
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
  app.get("/v1/discord/auth-policy", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    try {
      const policy = getDiscordAuthPolicy();
      const result = await queryDb(
        `
        SELECT *
        FROM discord_guilds
        ORDER BY grants_login DESC, unit_priority DESC, rank_priority DESC, config_order ASC, name ASC
        `
      );

      return { ok: true, policy, guilds: result.rows };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to load Discord auth policy");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/auth-policy/sync", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    try {
      const seeded = await syncDiscordAuthPolicyToDb();
      return { ok: true, seeded_guild_count: seeded };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to seed Discord auth policy");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.put("/v1/discord/guilds/:guild_id/auth-policy", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = guildAuthPolicyBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const body = parsedBody.data;

    try {
      const result = await queryDb(
        `
        UPDATE discord_guilds
        SET guild_type = $2,
            grants_login = $3,
            sync_members = $4,
            is_fallback = $5,
            unit_priority = $6,
            rank_priority = $7,
            permission_priority = $8,
            config_order = $9,
            config_source = 'db',
            last_config_loaded_at = now(),
            updated_at = now()
        WHERE guild_id = $1
        RETURNING *
        `,
        [
          parsedParams.data.guild_id,
          body.guild_type,
          body.grants_login,
          body.sync_members,
          body.is_fallback,
          body.unit_priority,
          body.rank_priority,
          body.permission_priority,
          body.config_order
        ]
      );

      const guild = result.rows[0];
      if (!guild) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      return { ok: true, guild };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update Discord auth policy");
      return sendDatabaseUnavailable(reply);
    }
  });

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
          COUNT(DISTINCT pdl.discord_user_id)::int AS linked_member_count,
          COUNT(DISTINCT dar.id) FILTER (WHERE dar.is_enabled = true)::int AS enabled_rule_count
        FROM discord_guilds dg
        LEFT JOIN discord_roles dr ON dr.guild_id = dg.guild_id AND dr.is_deleted = false
        LEFT JOIN discord_member_snapshots dms ON dms.guild_id = dg.guild_id
        LEFT JOIN player_discord_links pdl ON pdl.discord_user_id = dms.discord_user_id
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
          COUNT(DISTINCT pdl.discord_user_id)::int AS linked_member_count,
          COUNT(DISTINCT dar.id) FILTER (WHERE dar.is_enabled = true)::int AS enabled_rule_count
        FROM discord_guilds dg
        LEFT JOIN discord_roles dr ON dr.guild_id = dg.guild_id AND dr.is_deleted = false
        LEFT JOIN discord_member_snapshots dms ON dms.guild_id = dg.guild_id
        LEFT JOIN player_discord_links pdl ON pdl.discord_user_id = dms.discord_user_id
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

  app.post("/v1/discord/guilds/:guild_id/roles", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = roleBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;
    const body = parsedBody.data;

    try {
      if (!(await guildExists(guildId))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      return await getDrizzleDb().transaction(async (tx) => {
        const [role] = await tx
          .insert(discordRoles)
          .values({
            guildId,
            roleId: body.role_id,
            name: body.name,
            assignable: body.assignable,
            managed: false,
            isDeleted: false,
            rawRole: { source: "manual_admin" }
          })
          .onConflictDoUpdate({
            target: [discordRoles.guildId, discordRoles.roleId],
            set: {
              name: sql`excluded.name`,
              assignable: sql`excluded.assignable`,
              managed: false,
              isDeleted: false,
              lastSeenAt: sql`now()`,
              updatedAt: sql`now()`,
              rawRole: sql`excluded.raw_role`
            }
          })
          .returning({
            guild_id: discordRoles.guildId,
            role_id: discordRoles.roleId,
            name: discordRoles.name,
            color: discordRoles.color,
            position: discordRoles.position,
            managed: discordRoles.managed,
            assignable: discordRoles.assignable,
            is_deleted: discordRoles.isDeleted,
            last_seen_at: discordRoles.lastSeenAt,
            updated_at: discordRoles.updatedAt
          });

        await tx
          .update(discordGuilds)
          .set({
            grantsLogin: true,
            syncMembers: true,
            configSource: sql`CASE WHEN ${discordGuilds.configSource} = 'file' THEN ${discordGuilds.configSource} ELSE 'db' END`,
            lastConfigLoadedAt: sql`now()`,
            updatedAt: sql`now()`
          })
          .where(eq(discordGuilds.guildId, guildId));

        const linkedUnits = body.unit_id
          ? await tx
              .select({
                unit_id: units.id
              })
              .from(units)
              .where(and(eq(units.id, body.unit_id), sql`${units.deletedAt} IS NULL`))
              .limit(1)
          : await tx
              .selectDistinct({
                unit_id: units.id
              })
              .from(units)
              .leftJoin(unitDiscordGuilds, eq(unitDiscordGuilds.unitId, units.id))
              .where(and(sql`${units.deletedAt} IS NULL`, sql`(${units.primaryDiscordGuildId} = ${guildId} OR ${unitDiscordGuilds.guildId} = ${guildId})`))
              .limit(2);

        if (body.unit_id && linkedUnits.length === 0) {
          return reply.code(404).send({ ok: false, error: { code: "unit_not_found", message: "Battalion was not found." } });
        }

        if (!body.unit_id && linkedUnits.length !== 1) {
          return { ok: true, role, mapping: null, linked_unit_count: linkedUnits.length };
        }

        const unitId = linkedUnits[0]?.unit_id;
        if (!unitId) {
          return { ok: true, role, mapping: null, linked_unit_count: linkedUnits.length };
        }

        const mapping = await upsertDiscordRoleMapping(tx, guildId, {
          role_id: body.role_id,
          mapping_type: "unit_primary",
          unit_id: unitId,
          priority: body.priority,
          is_enabled: true,
          notes: "Created from COMMS unit mapping role attach."
        });

        const memberMapping = await upsertDiscordRoleMapping(tx, guildId, {
          role_id: body.role_id,
          mapping_type: "unit_role",
          unit_id: unitId,
          unit_role: "member",
          priority: body.priority,
          is_enabled: true,
          notes: "Created from COMMS unit mapping role attach."
        });

        return { ok: true, role, mapping, member_mapping: memberMapping, linked_unit_count: linkedUnits.length };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to attach Discord role");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/discord/guilds/:guild_id/roles/:role_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = roleParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { guild_id: guildId, role_id: roleId } = parsedParams.data;

    try {
      return await getDrizzleDb().transaction(async (tx) => {
        const [role] = await tx
          .select({ role_id: discordRoles.roleId })
          .from(discordRoles)
          .where(and(eq(discordRoles.guildId, guildId), eq(discordRoles.roleId, roleId)))
          .limit(1);

        if (!role) {
          return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
        }

        const removedMappings = await tx
          .delete(discordRoleMappings)
          .where(and(eq(discordRoleMappings.guildId, guildId), eq(discordRoleMappings.roleId, roleId)))
          .returning({ id: discordRoleMappings.id });

        await tx
          .update(discordRoles)
          .set({
            assignable: false,
            isDeleted: true,
            updatedAt: sql`now()`
          })
          .where(and(eq(discordRoles.guildId, guildId), eq(discordRoles.roleId, roleId)));

        return { ok: true, role_id: roleId, removed_mapping_count: removedMappings.length };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to delete Discord role");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id/member-snapshots", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedQuery = memberSnapshotQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [parsedParams.data.guild_id];
    const where = ["dms.guild_id = $1"];
    if (parsedQuery.data.discord_user_id) {
      values.push(parsedQuery.data.discord_user_id);
      where.push(`dms.discord_user_id = $${values.length}`);
    }
    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb(
        `
        SELECT dms.*, au.display_name AS user_display_name
        FROM discord_member_snapshots dms
        LEFT JOIN app_users au ON au.id = dms.user_id
        WHERE ${where.join(" AND ")}
        ORDER BY dms.last_seen_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return { ok: true, snapshots: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/member-snapshots", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = memberSnapshotBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;

    try {
      if (!(await guildExists(guildId))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      const members = parsedBody.data.members;
      const db = getDrizzleDb();

      await db.transaction(async (tx) => {
        for (const member of members) {
          await tx
            .insert(discordMemberSnapshots)
            .values({
              guildId,
              discordUserId: member.discord_user_id,
              roleIds: member.roles,
              nick: member.nick ?? null,
              joinedAt: member.joined_at ? new Date(member.joined_at) : null,
              memberPayload: member.raw_member ?? member,
              source: "bot_snapshot",
              lastSeenAt: sql`now()`
            })
            .onConflictDoUpdate({
              target: [discordMemberSnapshots.guildId, discordMemberSnapshots.discordUserId],
              set: {
                userId: sql`COALESCE(excluded.user_id, ${discordMemberSnapshots.userId}, (SELECT user_id FROM user_identities WHERE provider = 'discord' AND provider_user_id = excluded.discord_user_id ORDER BY last_seen_at DESC LIMIT 1))`,
                roleIds: sql`excluded.role_ids`,
                nick: sql`excluded.nick`,
                joinedAt: sql`excluded.joined_at`,
                memberPayload: sql`excluded.member_payload`,
                source: sql`excluded.source`,
                lastSeenAt: sql`now()`,
                lastError: null,
                updatedAt: sql`now()`
              }
            });
        }

        await tx
          .update(discordGuilds)
          .set({ lastMemberSyncAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(discordGuilds.guildId, guildId));
      });

      const reconciled = [];
      if (parsedBody.data.reconcile) {
        for (const discordUserId of new Set(members.map((member) => member.discord_user_id))) {
          reconciled.push(
            await reconcileDiscordMembership({
              discordUserId,
              dryRun: false,
              source: "bot_snapshot"
            })
          );
        }
      }

      return { ok: true, guild_id: guildId, snapshots_upserted: parsedBody.data.members.length, reconciled };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to ingest Discord member snapshots");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id/role-mappings", async (request, reply) => {
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
        SELECT drm.*, dr.name AS role_name, u.name AS unit_name, ur.name AS rank_name
        FROM discord_role_mappings drm
        LEFT JOIN discord_roles dr ON dr.guild_id = drm.guild_id AND dr.role_id = drm.role_id
        LEFT JOIN units u ON u.id = drm.unit_id
        LEFT JOIN unit_ranks ur ON ur.id = drm.rank_id
        WHERE drm.guild_id = $1
        ORDER BY drm.is_enabled DESC, drm.mapping_type ASC, drm.priority DESC, dr.position DESC NULLS LAST
        `,
        [parsedParams.data.guild_id]
      );

      return { ok: true, mappings: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/role-mappings", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = roleMappingBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;
    const body = parsedBody.data;

    try {
      if (!(await roleExists(guildId, body.role_id))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const mapping = await getDrizzleDb().transaction((tx) => upsertDiscordRoleMapping(tx, guildId, body));

      return { ok: true, mapping };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create Discord role mapping");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/discord/guilds/:guild_id/role-mappings/:mapping_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = roleMappingParamsSchema.safeParse(request.params);
    const parsedBody = roleMappingPatchSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    try {
      const currentResult = await getDrizzleDb()
        .select({
          id: discordRoleMappings.id,
          role_id: discordRoleMappings.roleId,
          mapping_type: discordRoleMappings.mappingType,
          unit_id: discordRoleMappings.unitId,
          rank_id: discordRoleMappings.rankId,
          unit_role: discordRoleMappings.unitRole,
          app_role: discordRoleMappings.appRole,
          roster_status: discordRoleMappings.rosterStatus,
          priority: discordRoleMappings.priority,
          is_enabled: discordRoleMappings.isEnabled,
          notes: discordRoleMappings.notes
        })
        .from(discordRoleMappings)
        .where(and(eq(discordRoleMappings.guildId, parsedParams.data.guild_id), eq(discordRoleMappings.id, parsedParams.data.mapping_id)))
        .limit(1);

      const current = currentResult[0] as RoleMappingRow | undefined;
      if (!current) {
        return reply.code(404).send({ ok: false, error: { code: "mapping_not_found", message: "Discord role mapping was not found." } });
      }

      const body = parsedBody.data;
      const merged = roleMappingBodySchema.safeParse(mergeRoleMappingPatch(roleMappingRowToInput(current), body));

      if (!merged.success) {
        return sendValidationFailed(reply);
      }

      if (merged.data.role_id !== current.role_id && !(await roleExists(parsedParams.data.guild_id, merged.data.role_id))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const values = roleMappingInputToDbValues(parsedParams.data.guild_id, merged.data);
      const duplicate = await getDrizzleDb().transaction((tx) => findExistingRoleMapping(tx, values, current.id));

      if (duplicate) {
        return reply.code(409).send({
          ok: false,
          error: {
            code: "duplicate_mapping",
            message: "A Discord role mapping with the same role, type, and target already exists."
          }
        });
      }

      const [mapping] = await getDrizzleDb()
        .update(discordRoleMappings)
        .set({
          roleId: values.roleId,
          mappingType: values.mappingType,
          unitId: values.unitId,
          rankId: values.rankId,
          unitRole: values.unitRole,
          appRole: values.appRole,
          rosterStatus: values.rosterStatus,
          priority: values.priority,
          isEnabled: values.isEnabled,
          notes: values.notes,
          updatedAt: sql`now()`
        })
        .where(and(eq(discordRoleMappings.guildId, parsedParams.data.guild_id), eq(discordRoleMappings.id, current.id)))
        .returning(discordRoleMappingReturning);

      return { ok: true, mapping };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update Discord role mapping");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/discord/guilds/:guild_id/role-mappings/:mapping_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = roleMappingParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await getDrizzleDb()
        .delete(discordRoleMappings)
        .where(and(eq(discordRoleMappings.guildId, parsedParams.data.guild_id), eq(discordRoleMappings.id, parsedParams.data.mapping_id)))
        .returning({ id: discordRoleMappings.id });

      return { ok: true, deleted: result.length };
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

  app.post("/v1/discord/reconcile", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedBody = reconcileBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await reconcileDiscordMembership({
        ...(parsedBody.data.user_id ? { userId: parsedBody.data.user_id } : {}),
        ...(parsedBody.data.discord_user_id ? { discordUserId: parsedBody.data.discord_user_id } : {}),
        ...(parsedBody.data.guild_id ? { guildId: parsedBody.data.guild_id } : {}),
        dryRun: parsedBody.data.dry_run,
        source: parsedBody.data.dry_run ? "discord_reconcile_dry_run" : "discord_reconcile"
      });

      return result;
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to reconcile Discord membership");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/assignment-audits", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedQuery = assignmentAuditsQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [];
    const where: string[] = [];

    if (parsedQuery.data.user_id) {
      values.push(parsedQuery.data.user_id);
      where.push(`daa.user_id = $${values.length}::uuid`);
    }

    if (parsedQuery.data.player_uid) {
      values.push(parsedQuery.data.player_uid);
      where.push(`daa.player_uid = $${values.length}`);
    }

    if (parsedQuery.data.discord_user_id) {
      values.push(parsedQuery.data.discord_user_id);
      where.push(`daa.discord_user_id = $${values.length}`);
    }

    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb(
        `
        SELECT daa.*, au.display_name AS user_display_name, p.last_name AS player_name
        FROM discord_assignment_audits daa
        LEFT JOIN app_users au ON au.id = daa.user_id
        LEFT JOIN players p ON p.player_uid = daa.player_uid
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY daa.created_at DESC
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
