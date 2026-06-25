import assert from "node:assert/strict";

import { choosePreferredDiscordDisplayName } from "../apps/api/src/discord/displayName.js";
import type { DiscordDisplayNamePolicy, LoginGuildDisplayNamePolicy } from "../apps/api/src/config/discordAuth.js";
import type { DiscordCurrentGuildMember } from "../apps/api/src/discord/client.js";

const policy: DiscordDisplayNamePolicy = {
  preferGuildNick: true,
  guildOrder: "priority_then_file_order",
  fallback: ["global_name", "username", "discord_id"]
};

const guildOrder: LoginGuildDisplayNamePolicy[] = [
  { guildId: "guild-high", name: "High", displayNamePriority: 10, fileOrder: 0 },
  { guildId: "guild-low", name: "Low", displayNamePriority: 20, fileOrder: 1 }
];

const profile = {
  id: "1234567890",
  username: "global-username",
  global_name: "Global Name"
};

function member(input: Partial<DiscordCurrentGuildMember>): DiscordCurrentGuildMember {
  return {
    roles: [],
    ...input
  };
}

assert.deepEqual(
  choosePreferredDiscordDisplayName({
    profile,
    policy,
    guildOrder,
    memberships: [
      { guildId: "guild-low", member: member({ nick: "Low Nick" }) },
      { guildId: "guild-high", member: member({ nick: "High Nick" }) }
    ]
  }),
  { displayName: "High Nick", source: "guild_nick", guildId: "guild-high" }
);

assert.deepEqual(
  choosePreferredDiscordDisplayName({
    profile,
    policy,
    guildOrder,
    memberships: [
      { guildId: "guild-high", member: member({ nick: "   " }) },
      { guildId: "guild-low", member: member({ nick: "Low Nick" }) }
    ]
  }),
  { displayName: "Low Nick", source: "guild_nick", guildId: "guild-low" }
);

assert.deepEqual(
  choosePreferredDiscordDisplayName({
    profile,
    policy,
    guildOrder,
    memberships: [
      { guildId: "guild-high", member: member({ user: { id: "1234567890", global_name: "Guild Global" }, nick: "" }) }
    ]
  }),
  { displayName: "Guild Global", source: "guild_global_name", guildId: "guild-high" }
);

assert.deepEqual(
  choosePreferredDiscordDisplayName({
    profile,
    policy,
    guildOrder,
    memberships: [{ guildId: "unknown-guild", member: member({ nick: "Ignored Nick" }) }]
  }),
  { displayName: "Global Name", source: "global_name", guildId: null }
);

assert.deepEqual(
  choosePreferredDiscordDisplayName({
    profile: { id: "1234567890", username: "username-only", global_name: null },
    policy,
    guildOrder,
    memberships: []
  }),
  { displayName: "username-only", source: "username", guildId: null }
);

assert.deepEqual(
  choosePreferredDiscordDisplayName({
    profile: { id: "1234567890", username: "", global_name: null },
    policy,
    guildOrder,
    memberships: []
  }),
  { displayName: "Discord 1234567890", source: "discord_id", guildId: null }
);

assert.deepEqual(
  choosePreferredDiscordDisplayName({
    profile,
    policy,
    guildOrder,
    memberships: [
      { guildId: "guild-high", member: member({ nick: "First High" }) },
      { guildId: "guild-high", member: member({ nick: "Second High" }) }
    ]
  }),
  { displayName: "First High", source: "guild_nick", guildId: "guild-high" }
);

console.log("[discord-display-name] OK");
