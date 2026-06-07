import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV ??= "test";
process.env.APP_NAME ??= "arma-attendance";
process.env.APP_VERSION ??= "0.1.0";
process.env.HOST ??= "127.0.0.1";
process.env.PORT ??= "3000";
process.env.PUBLIC_BASE_URL ??= "http://127.0.0.1:3000";
process.env.API_TOKEN ??= "test-token";
process.env.LOG_LEVEL ??= "silent";
process.env.SESSION_SECRET ??= "test-session-secret-change-me";
process.env.JWT_SECRET ??= "test-jwt-secret-change-me-32chars";
process.env.DISCORD_AUTH_REQUIRE_CONFIG_FILE ??= "false";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(scriptDir, "fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as Record<string, unknown>;
}

async function main() {
  const { DiscordAuthPolicyError, resolveDiscordAuthPolicy } = await import("../apps/api/src/config/discordAuth.js");

  const baseOptions = {
    authEnabled: true,
    configPath: "discord-guild-auth.json",
    configFileLoaded: true,
    defaultFallbackGuildIds: ["fallback-from-env"],
    allowFallbackGuildIds: false,
    requireConfigFile: true
  };

  const single = resolveDiscordAuthPolicy(fixture("discord-guild-auth.single.json"), baseOptions);
  assert.equal(single.source, "config-file");
  assert.deepEqual(single.configuredLoginGuildIds, ["guild-login-1"]);
  assert.equal(single.policy.guilds.some((guild) => guild.guildId === "fallback-from-env"), false);

  const multi = resolveDiscordAuthPolicy(fixture("discord-guild-auth.multi.json"), baseOptions);
  assert.equal(multi.source, "config-file");
  assert.deepEqual(multi.configuredLoginGuildIds, ["guild-login-high", "guild-login-low"]);

  assert.throws(
    () => resolveDiscordAuthPolicy(fixture("discord-guild-auth.empty.json"), baseOptions),
    DiscordAuthPolicyError
  );

  const fallback = resolveDiscordAuthPolicy(fixture("discord-guild-auth.empty.json"), {
    ...baseOptions,
    allowFallbackGuildIds: true,
    requireConfigFile: false
  });
  assert.equal(fallback.source, "fallback-env");
  assert.deepEqual(fallback.configuredLoginGuildIds, ["fallback-from-env"]);

  const none = resolveDiscordAuthPolicy(fixture("discord-guild-auth.empty.json"), {
    ...baseOptions,
    requireConfigFile: false
  });
  assert.equal(none.source, "none");
  assert.deepEqual(none.configuredLoginGuildIds, []);

  console.log("[discord-auth-policy-loader] source=config-file");
  console.log(`[discord-auth-policy-loader] login_guild_count=${single.configuredLoginGuildIds.length}`);
  console.log(`[discord-auth-policy-loader] fallback_allowed=${single.fallbackAllowed}`);
  console.log("[discord-auth-policy-loader] OK");
}

void main();
