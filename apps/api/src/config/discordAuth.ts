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
  displayNamePriority: z.number().int().optional(),
  unitPriority: z.number().int().default(0),
  rankPriority: z.number().int().default(0),
  permissionPriority: z.number().int().default(0),
  configOrder: z.number().int().default(1000)
});

const discordDisplayNamePolicySchema = z
  .object({
    preferGuildNick: z.boolean().default(true),
    guildOrder: z.enum(["file_order", "priority_then_file_order"]).default("priority_then_file_order"),
    fallback: z.array(z.enum(["global_name", "username", "discord_id"])).default(["global_name", "username", "discord_id"])
  })
  .default({
    preferGuildNick: true,
    guildOrder: "priority_then_file_order",
    fallback: ["global_name", "username", "discord_id"]
  });

const discordAuthPolicySchema = z.object({
  version: z.literal(1).default(1),
  defaultFallbackGuildIds: z.array(z.string().min(1).max(64)).default([]),
  guilds: z.array(discordAuthGuildSchema).default([]),
  displayName: discordDisplayNamePolicySchema,
  permissions: z
    .object({
      partnerGuildsMayGrantGlobalAdmin: z.boolean().default(false)
    })
    .default({ partnerGuildsMayGrantGlobalAdmin: false })
});

export type DiscordAuthGuildConfig = z.infer<typeof discordAuthGuildSchema>;
export type DiscordAuthPolicy = z.infer<typeof discordAuthPolicySchema>;
export type DiscordDisplayNamePolicy = z.infer<typeof discordDisplayNamePolicySchema>;
export type DiscordGuildPolicySource = "config-file" | "fallback-env" | "none";
export type LoginGuildDisplayNamePolicy = {
  guildId: string;
  name?: string | undefined;
  displayNamePriority: number;
  fileOrder: number;
};

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
  loginGuildDisplayNameOrder: LoginGuildDisplayNamePolicy[];
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

type OrderedDiscordAuthGuildConfig = DiscordAuthGuildConfig & { fileOrder: number };

function normalizeGuilds(inputGuilds: DiscordAuthGuildConfig[]): OrderedDiscordAuthGuildConfig[] {
  const normalizedGuilds = new Map<string, DiscordAuthGuildConfig>();
  const fileOrders = new Map<string, number>();

  for (const [index, rawGuild] of inputGuilds.entries()) {
    const guild = normalizeGuild(rawGuild);
    if (!normalizedGuilds.has(guild.guildId)) {
      normalizedGuilds.set(guild.guildId, guild);
      fileOrders.set(guild.guildId, index);
    }
  }

  return Array.from(normalizedGuilds.values()).map((guild) => ({ ...guild, fileOrder: fileOrders.get(guild.guildId) ?? 0 }));
}

function fallbackGuild(guildId: string, index: number): OrderedDiscordAuthGuildConfig {
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
    configOrder: 1000 + index,
    fileOrder: index
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

function compareDisplayNameGuilds(
  a: OrderedDiscordAuthGuildConfig,
  b: OrderedDiscordAuthGuildConfig,
  policy: DiscordDisplayNamePolicy
): number {
  if (policy.guildOrder === "priority_then_file_order") {
    const priority = (a.displayNamePriority ?? a.configOrder) - (b.displayNamePriority ?? b.configOrder);

    if (priority !== 0) {
      return priority;
    }
  }

  return a.fileOrder - b.fileOrder;
}

function getDisplayNameOrder(
  guilds: OrderedDiscordAuthGuildConfig[],
  policy: DiscordDisplayNamePolicy
): LoginGuildDisplayNamePolicy[] {
  return guilds
    .filter((guild) => guild.grantsLogin)
    .sort((a, b) => compareDisplayNameGuilds(a, b, policy))
    .map((guild) => ({
      guildId: guild.guildId,
      name: guild.label,
      displayNamePriority: guild.displayNamePriority ?? guild.configOrder,
      fileOrder: guild.fileOrder
    }));
}

function stripFileOrder(guilds: OrderedDiscordAuthGuildConfig[]): DiscordAuthGuildConfig[] {
  return guilds.map(({ fileOrder: _fileOrder, ...guild }) => guild);
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
  const fileLoginGuildDisplayNameOrder = getDisplayNameOrder(fileGuilds, parsed.displayName);
  const filePolicyWithNormalizedGuilds = {
    ...parsed,
    defaultFallbackGuildIds: uniqueIds(parsed.defaultFallbackGuildIds),
    guilds: stripFileOrder(fileGuilds)
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
      loginGuildDisplayNameOrder: [],
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
      loginGuildDisplayNameOrder: fileLoginGuildDisplayNameOrder,
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
      ...fileGuilds,
      ...fallbackGuildIds.filter((guildId) => !fileGuildIds.has(guildId)).map(fallbackGuild)
    ].sort(compareGuilds);
    const loginGuildDisplayNameOrder = getDisplayNameOrder(guilds, parsed.displayName);

    return {
      policy: {
        ...filePolicyWithNormalizedGuilds,
        defaultFallbackGuildIds: fallbackGuildIds,
        guilds: stripFileOrder(guilds)
      },
      source: "fallback-env",
      configPath: options.configPath,
      configuredLoginGuildIds: fallbackGuildIds,
      loginGuildDisplayNameOrder,
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
    loginGuildDisplayNameOrder: [],
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

export function getDiscordDisplayNamePolicy(): DiscordDisplayNamePolicy {
  return getDiscordAuthPolicyDetails().policy.displayName;
}

export function getLoginGuildDisplayNameOrder(): LoginGuildDisplayNamePolicy[] {
  return getDiscordAuthPolicyDetails().loginGuildDisplayNameOrder;
}
