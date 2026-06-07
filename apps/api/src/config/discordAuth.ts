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
  permissions: z
    .object({
      partnerGuildsMayGrantGlobalAdmin: z.boolean().default(false)
    })
    .default({ partnerGuildsMayGrantGlobalAdmin: false })
});

export type DiscordAuthGuildConfig = z.infer<typeof discordAuthGuildSchema>;
export type DiscordAuthPolicy = z.infer<typeof discordAuthPolicySchema>;
export type DiscordGuildPolicySource = "config-file" | "fallback-env" | "none";

export type DiscordAuthPolicyResolutionOptions = {
  authEnabled: boolean;
  configPath?: string | undefined;
  configFileLoaded: boolean;
  defaultFallbackGuildIds: string[];
  allowFallbackGuildIds: boolean;
  requireConfigFile: boolean;
};

export type DiscordAuthPolicyDetails = {
  policy: DiscordAuthPolicy;
  source: DiscordGuildPolicySource;
  configPath?: string | undefined;
  configuredLoginGuildIds: string[];
  fallbackGuildIds: string[];
  fallbackAllowed: boolean;
  requireConfigFile: boolean;
};

export class DiscordAuthPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordAuthPolicyError";
  }
}

function readPolicyFile(): { loaded: boolean; path?: string | undefined; policy: Partial<DiscordAuthPolicy> } {
  if (!config.discordAuthConfigPath) {
    return { loaded: false, policy: {} };
  }

  const path = resolve(process.cwd(), config.discordAuthConfigPath);
  if (!existsSync(path)) {
    return { loaded: false, path, policy: {} };
  }

  return { loaded: true, path, policy: JSON.parse(readFileSync(path, "utf8")) as Partial<DiscordAuthPolicy> };
}

function normalizeGuild(guild: DiscordAuthGuildConfig): DiscordAuthGuildConfig {
  return {
    ...guild,
    guildId: guild.guildId.trim(),
    label: guild.label?.trim() || guild.guildId.trim()
  };
}

function normalizeGuilds(inputGuilds: DiscordAuthGuildConfig[]): DiscordAuthGuildConfig[] {
  const normalizedGuilds = new Map<string, DiscordAuthGuildConfig>();

  for (const guild of inputGuilds.map(normalizeGuild)) {
    if (!normalizedGuilds.has(guild.guildId)) {
      normalizedGuilds.set(guild.guildId, guild);
    }
  }

  return Array.from(normalizedGuilds.values());
}

function fallbackGuild(guildId: string, index: number): DiscordAuthGuildConfig {
  return {
    guildId,
    label: guildId,
    type: "fallback",
    grantsLogin: true,
    syncMembers: true,
    fallback: true,
    unitPriority: 10,
    rankPriority: 10,
    permissionPriority: 50,
    configOrder: 1000 + index
  };
}

function uniqueIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function compareGuilds(a: DiscordAuthGuildConfig, b: DiscordAuthGuildConfig): number {
  return (
    b.unitPriority - a.unitPriority ||
    b.rankPriority - a.rankPriority ||
    b.permissionPriority - a.permissionPriority ||
    a.configOrder - b.configOrder ||
    (a.label ?? a.guildId).localeCompare(b.label ?? b.guildId)
  );
}

export function resolveDiscordAuthPolicy(
  filePolicy: Partial<DiscordAuthPolicy>,
  options: DiscordAuthPolicyResolutionOptions
): DiscordAuthPolicyDetails {
  const parsed = discordAuthPolicySchema.parse({
    version: 1,
    ...filePolicy,
    defaultFallbackGuildIds: filePolicy.defaultFallbackGuildIds ?? []
  });
  const fileGuilds = normalizeGuilds(parsed.guilds).sort(compareGuilds);
  const fileLoginGuildIds = uniqueIds(fileGuilds.filter((guild) => guild.grantsLogin).map((guild) => guild.guildId));
  const filePolicyWithNormalizedGuilds = {
    ...parsed,
    defaultFallbackGuildIds: uniqueIds(parsed.defaultFallbackGuildIds),
    guilds: fileGuilds
  };
  const fallbackGuildIds = uniqueIds([
    ...filePolicyWithNormalizedGuilds.defaultFallbackGuildIds,
    ...options.defaultFallbackGuildIds
  ]);

  if (!options.authEnabled) {
    return {
      policy: filePolicyWithNormalizedGuilds,
      source: "none",
      configPath: options.configPath,
      configuredLoginGuildIds: [],
      fallbackGuildIds,
      fallbackAllowed: options.allowFallbackGuildIds,
      requireConfigFile: options.requireConfigFile
    };
  }

  if (options.configFileLoaded && fileLoginGuildIds.length > 0) {
    return {
      policy: filePolicyWithNormalizedGuilds,
      source: "config-file",
      configPath: options.configPath,
      configuredLoginGuildIds: fileLoginGuildIds,
      fallbackGuildIds,
      fallbackAllowed: options.allowFallbackGuildIds,
      requireConfigFile: options.requireConfigFile
    };
  }

  if (options.requireConfigFile) {
    const reason = options.configFileLoaded ? "no login guilds were loaded" : "the config file was not found";
    throw new DiscordAuthPolicyError(`Discord auth config file is required but ${reason}.`);
  }

  if (options.allowFallbackGuildIds && fallbackGuildIds.length > 0) {
    const fileGuildIds = new Set(filePolicyWithNormalizedGuilds.guilds.map((guild) => guild.guildId));
    const guilds = [
      ...filePolicyWithNormalizedGuilds.guilds,
      ...fallbackGuildIds.filter((guildId) => !fileGuildIds.has(guildId)).map(fallbackGuild)
    ].sort(compareGuilds);

    return {
      policy: {
        ...filePolicyWithNormalizedGuilds,
        defaultFallbackGuildIds: fallbackGuildIds,
        guilds
      },
      source: "fallback-env",
      configPath: options.configPath,
      configuredLoginGuildIds: fallbackGuildIds,
      fallbackGuildIds,
      fallbackAllowed: options.allowFallbackGuildIds,
      requireConfigFile: options.requireConfigFile
    };
  }

  return {
    policy: filePolicyWithNormalizedGuilds,
    source: "none",
    configPath: options.configPath,
    configuredLoginGuildIds: [],
    fallbackGuildIds,
    fallbackAllowed: options.allowFallbackGuildIds,
    requireConfigFile: options.requireConfigFile
  };
}

export function getDiscordAuthPolicyDetails(): DiscordAuthPolicyDetails {
  const file = readPolicyFile();

  return resolveDiscordAuthPolicy(file.policy, {
    authEnabled: config.discordAuthEnabled,
    configPath: file.path ?? config.discordAuthConfigPath,
    configFileLoaded: file.loaded,
    defaultFallbackGuildIds: config.discordAuthDefaultFallbackGuildIds,
    allowFallbackGuildIds: config.discordAuthAllowFallbackGuildIds,
    requireConfigFile: config.discordAuthRequireConfigFile
  });
}

export function getDiscordAuthPolicy(): DiscordAuthPolicy {
  return getDiscordAuthPolicyDetails().policy;
}

export function getAuthGuilds(): DiscordAuthGuildConfig[] {
  return getDiscordAuthPolicy().guilds;
}

export function getLoginGrantGuildIds(): string[] {
  return getDiscordAuthPolicyDetails().configuredLoginGuildIds;
}
