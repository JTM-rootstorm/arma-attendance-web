import type { DiscordDisplayNamePolicy, LoginGuildDisplayNamePolicy } from "../config/discordAuth.js";
import type { DiscordCurrentGuildMember } from "./client.js";

type DiscordDisplayProfile = {
  id: string;
  username?: string | undefined;
  global_name?: string | null | undefined;
};

export type PreferredDiscordDisplayName = {
  displayName: string;
  source:
    | "guild_nick"
    | "guild_global_name"
    | "guild_username"
    | "global_name"
    | "username"
    | "discord_id";
  guildId: string | null;
};

type Membership = {
  guildId: string;
  member: DiscordCurrentGuildMember;
};

function cleanDisplayName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, 200);
}

function profileFallback(
  profile: DiscordDisplayProfile,
  policy: DiscordDisplayNamePolicy
): PreferredDiscordDisplayName {
  for (const fallback of policy.fallback) {
    if (fallback === "global_name") {
      const displayName = cleanDisplayName(profile.global_name);

      if (displayName) {
        return { displayName, source: "global_name", guildId: null };
      }
    }

    if (fallback === "username") {
      const displayName = cleanDisplayName(profile.username);

      if (displayName) {
        return { displayName, source: "username", guildId: null };
      }
    }

    if (fallback === "discord_id") {
      return { displayName: `Discord ${profile.id}`.slice(0, 200), source: "discord_id", guildId: null };
    }
  }

  return { displayName: `Discord ${profile.id}`.slice(0, 200), source: "discord_id", guildId: null };
}

export function choosePreferredDiscordDisplayName(args: {
  profile: DiscordDisplayProfile;
  memberships: Membership[];
  policy: DiscordDisplayNamePolicy;
  guildOrder: LoginGuildDisplayNamePolicy[];
}): PreferredDiscordDisplayName {
  const membershipsByGuild = new Map<string, DiscordCurrentGuildMember>();

  for (const membership of args.memberships) {
    if (!membershipsByGuild.has(membership.guildId)) {
      membershipsByGuild.set(membership.guildId, membership.member);
    }
  }

  for (const guild of args.guildOrder) {
    const member = membershipsByGuild.get(guild.guildId);

    if (!member) {
      continue;
    }

    if (args.policy.preferGuildNick) {
      const nick = cleanDisplayName(member.nick);

      if (nick) {
        return { displayName: nick, source: "guild_nick", guildId: guild.guildId };
      }
    }

    const guildGlobalName = cleanDisplayName(member.user?.global_name);

    if (guildGlobalName) {
      return { displayName: guildGlobalName, source: "guild_global_name", guildId: guild.guildId };
    }

    const guildUsername = cleanDisplayName(member.user?.username);

    if (guildUsername) {
      return { displayName: guildUsername, source: "guild_username", guildId: guild.guildId };
    }
  }

  return profileFallback(args.profile, args.policy);
}
