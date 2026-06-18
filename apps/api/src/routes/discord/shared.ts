import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { hasRole } from "../../auth.js";
import { deny, getAuthContext, type AuthContext } from "../../auth/authorization.js";
import { getUserUnitRoles } from "../../auth/units.js";
import { getDrizzleDb } from "../../db/drizzle.js";
import { discordAttendanceRules, discordGuilds, discordRoleMappings, discordRoles, playerDiscordLinks } from "../../db/schema/discord.js";
import { players } from "../../db/schema/players.js";

export type DrizzleDb = ReturnType<typeof getDrizzleDb>;
export type DrizzleTransaction = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

export const guildSyncSchema = z.object({
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

export const guildParamsSchema = z.object({
  guild_id: z.string().min(1).max(64)
});

export const roleBodySchema = z.object({
  role_id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  unit_id: z.string().uuid().nullable().optional(),
  priority: z.number().int().default(0),
  assignable: z.boolean().default(true)
});

export const roleParamsSchema = guildParamsSchema.extend({
  role_id: z.string().min(1).max(64)
});

export const ruleParamsSchema = guildParamsSchema.extend({
  rule_id: z.string().uuid()
});

export const roleMappingParamsSchema = guildParamsSchema.extend({
  mapping_id: z.string().uuid()
});

export const linkParamsSchema = z.object({
  discord_user_id: z.string().min(1).max(64)
});

export const playerLinksQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const playerLinkBodySchema = z.object({
  player_uid: z.string().min(1).max(200),
  discord_user_id: z.string().min(1).max(64),
  discord_username: z.string().max(200).optional(),
  discord_display_name: z.string().max(200).optional(),
  source: z.enum(["manual", "bot", "import"]).default("manual"),
  verified: z.boolean().optional(),
  raw_link: z.record(z.string(), z.unknown()).optional()
});

export const ruleBodySchema = z.object({
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

export const rulePatchSchema = ruleBodySchema.partial();

export const guildAuthPolicyBodySchema = z.object({
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

export const roleMappingBodySchema = z.discriminatedUnion("mapping_type", [
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

export const roleMappingPatchSchema = z
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

export const memberSnapshotBodySchema = z.object({
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

export const discordBotAssignmentBodySchema = z
  .object({
    discord_user_id: z.string().min(1).max(64).optional(),
    player_uid: z.string().min(1).max(200).optional(),
    guild_id: z.string().min(1).max(64).optional(),
    role_id: z.string().min(1).max(64).optional(),
    unit_id: z.string().uuid().optional(),
    unit_key: z.string().trim().min(1).max(120).optional(),
    rank_id: z.string().uuid().nullable().optional(),
    rank: z.string().trim().max(120).nullable().optional(),
    roster_name: z.string().trim().max(200).nullable().optional(),
    roster_status: z.enum(["active", "reserve", "loa", "inactive"]).default("active"),
    discord_username: z.string().max(200).nullable().optional(),
    discord_display_name: z.string().max(200).nullable().optional(),
    nick: z.string().max(200).nullable().optional(),
    is_active: z.boolean().default(true),
    assignment_priority: z.number().int().default(0),
    create_player_if_missing: z.boolean().default(true),
    dry_run: z.boolean().default(false),
    raw_member: z.record(z.string(), z.unknown()).optional()
  })
  .refine((body) => body.discord_user_id || body.player_uid, {
    message: "discord_user_id or player_uid is required."
  })
  .refine((body) => body.unit_id || body.unit_key, {
    message: "unit_id or unit_key is required."
  });

export const memberSnapshotQuerySchema = z.object({
  discord_user_id: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

export const reconcileBodySchema = z
  .object({
    discord_user_id: z.string().min(1).max(64).optional(),
    user_id: z.string().uuid().optional(),
    guild_id: z.string().min(1).max(64).optional(),
    dry_run: z.boolean().default(true)
  })
  .refine((body) => body.discord_user_id || body.user_id, {
    message: "discord_user_id or user_id is required."
  });

export const assignmentAuditsQuerySchema = z.object({
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

export const roleActionsQuerySchema = z.object({
  dry_run: queryBooleanSchema.default(true),
  persist: queryBooleanSchema.default(false)
});

export const roleActionResultsBodySchema = z.object({
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

export const auditsQuerySchema = z.object({
  evaluation_id: z.string().uuid().optional(),
  player_uid: z.string().max(200).optional(),
  discord_user_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const playerDiscordLinkReturning = {
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

export const discordAttendanceRuleReturning = {
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

export const discordRoleMappingReturning = {
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

export async function guildExists(guildId: string): Promise<boolean> {
  const rows = await getDrizzleDb().select({ guild_id: discordGuilds.guildId }).from(discordGuilds).where(eq(discordGuilds.guildId, guildId)).limit(1);
  return Boolean(rows[0]);
}

export async function roleExists(guildId: string, roleId: string): Promise<boolean> {
  const rows = await getDrizzleDb()
    .select({ role_id: discordRoles.roleId })
    .from(discordRoles)
    .where(and(eq(discordRoles.guildId, guildId), eq(discordRoles.roleId, roleId), eq(discordRoles.isDeleted, false)))
    .limit(1);
  return Boolean(rows[0]);
}

export async function playerExists(playerUid: string): Promise<boolean> {
  const rows = await getDrizzleDb()
    .select({ player_uid: players.playerUid })
    .from(players)
    .where(and(eq(players.playerUid, playerUid), isNull(players.deletedAt)))
    .limit(1);
  return Boolean(rows[0]);
}

export async function requireAnyDiscordAdmin(
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
