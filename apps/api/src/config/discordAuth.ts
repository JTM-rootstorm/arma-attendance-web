import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { config } from "../config.js";

const guildTypeSchema = z.enum(["fallback", "partner", "internal", "unknown"]);

const discordAuthGuildSchema = z.object({
  guildId: z.string().min(1).max(64),
  label: z.string().min(1).max(200).optional(),
  type: guildTypeSchema.default("unknown"),
  grantsLogin: z.boolean().default(false),
  syncMembers: z.boolean().default(false),
  fallback: z.boolean().default(false),
  unitPriority: z.number().int().default(0),
  rankPriority: z.number().int().default(0),
  permissionPriority: z.number().int().default(0),
  configOrder: z.number().int().default(1000)
});

const discordAuthPolicySchema = z.object({
  version: z.literal(1).default(1),
  defaultFallbackGuildIds: z.array(z.string().min(1).max(64)).default([]),
  guilds: z.array(discordAuthGuildSchema).default([]),
  tieBreakers: z.array(z.enum(["guildPriority", "mappingPriority", "rolePosition", "configOrder"])).default([
    "guildPriority",
    "mappingPriority",
    "rolePosition",
    "configOrder"
  ]),
  denyRoleBehavior: z.enum(["deny_login_overrides_all"]).default("deny_login_overrides_all"),
  permissions: z
    .object({
      partnerGuildsMayGrantGlobalAdmin: z.boolean().default(false)
    })
    .default({ partnerGuildsMayGrantGlobalAdmin: false })
});

export type DiscordAuthGuildConfig = z.infer<typeof discordAuthGuildSchema>;
export type DiscordAuthPolicy = z.infer<typeof discordAuthPolicySchema>;

function readPolicyFile(): Partial<DiscordAuthPolicy> {
  if (!config.discordAuthConfigPath) {
    return {};
  }

  const path = resolve(process.cwd(), config.discordAuthConfigPath);
  if (!existsSync(path)) {
    return {};
  }

  return JSON.parse(readFileSync(path, "utf8")) as Partial<DiscordAuthPolicy>;
}

function normalizeGuild(guild: DiscordAuthGuildConfig): DiscordAuthGuildConfig {
  return {
    ...guild,
    guildId: guild.guildId.trim(),
    label: guild.label?.trim() || guild.guildId.trim()
  };
}

function ensureFallbackGuilds(policy: DiscordAuthPolicy): DiscordAuthPolicy {
  const fallbackIds = Array.from(
    new Set([...policy.defaultFallbackGuildIds, ...config.discordAuthDefaultFallbackGuildIds].map((value) => value.trim()).filter(Boolean))
  );
  const guilds = new Map<string, DiscordAuthGuildConfig>();

  for (const guild of policy.guilds.map(normalizeGuild)) {
    const existing = guilds.get(guild.guildId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(guild)) {
      throw new Error(`Discord auth policy has duplicate guild_id with conflicting configuration: ${guild.guildId}`);
    }
    guilds.set(guild.guildId, guild);
  }

  for (const guildId of fallbackIds) {
    if (!guilds.has(guildId)) {
      guilds.set(guildId, {
        guildId,
        label: guildId,
        type: "fallback",
        grantsLogin: true,
        syncMembers: true,
        fallback: true,
        unitPriority: 10,
        rankPriority: 10,
        permissionPriority: 50,
        configOrder: 1000
      });
    }
  }

  return {
    ...policy,
    defaultFallbackGuildIds: fallbackIds,
    guilds: Array.from(guilds.values())
  };
}

export function getDiscordAuthPolicy(): DiscordAuthPolicy {
  const filePolicy = readPolicyFile();
  const parsed = discordAuthPolicySchema.parse({
    version: 1,
    ...filePolicy,
    defaultFallbackGuildIds: filePolicy.defaultFallbackGuildIds ?? config.discordAuthDefaultFallbackGuildIds
  });

  return ensureFallbackGuilds(parsed);
}

export function getAuthGuilds(): DiscordAuthGuildConfig[] {
  return getDiscordAuthPolicy().guilds;
}

export function getLoginGrantGuildIds(): string[] {
  return getAuthGuilds()
    .filter((guild) => guild.grantsLogin)
    .map((guild) => guild.guildId);
}

export function getFallbackGuildIds(): string[] {
  return getAuthGuilds()
    .filter((guild) => guild.fallback || guild.type === "fallback")
    .map((guild) => guild.guildId);
}

export function getGuildPriority(guildId: string, field: "unit" | "rank" | "permission"): number {
  const guild = getAuthGuilds().find((candidate) => candidate.guildId === guildId);
  if (!guild) {
    return 0;
  }

  if (field === "unit") {
    return guild.unitPriority;
  }

  if (field === "rank") {
    return guild.rankPriority;
  }

  return guild.permissionPriority;
}
