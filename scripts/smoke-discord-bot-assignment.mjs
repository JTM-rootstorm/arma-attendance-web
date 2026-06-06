#!/usr/bin/env node

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const botToken = process.env.BOT_API_TOKEN ?? process.env.API_TOKEN ?? "dev-token";
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const discordUserId = process.env.DISCORD_USER_ID ?? `999000${stamp.slice(-12)}`;
const guildId = process.env.GUILD_ID ?? `guild-${stamp}`;
const roleId = process.env.ROLE_ID ?? `role-assignment-${stamp}`;
const unitKey = process.env.UNIT_KEY ?? "tcw";

function fail(message) {
  console.error(`[smoke:discord-bot-assignment] ${message}`);
  process.exit(1);
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(body);
    fail(`${init.method ?? "GET"} ${path} returned ${response.status}`);
  }

  return body;
}

function assertOk(body, label) {
  if (!body || body.ok !== true) {
    console.error(body);
    fail(`${label} did not return ok: true`);
  }
}

console.log("[smoke:discord-bot-assignment] Applying dry-run assignment...");
const dryRun = await request("/v1/discord/player-assignments", {
  method: "POST",
  body: JSON.stringify({
    discord_user_id: discordUserId,
    guild_id: guildId,
    role_id: roleId,
    unit_key: unitKey,
    roster_name: "Smoke Test Trooper",
    create_player_if_missing: true,
    dry_run: true
  })
});
console.log(JSON.stringify(dryRun, null, 2));
assertOk(dryRun, "dry run");

if (dryRun.resolved_player_uid !== `discord:${discordUserId}`) {
  fail(`dry run resolved ${dryRun.resolved_player_uid}, expected discord:${discordUserId}`);
}

console.log("[smoke:discord-bot-assignment] Applying assignment...");
const applied = await request("/v1/discord/player-assignments", {
  method: "POST",
  body: JSON.stringify({
    discord_user_id: discordUserId,
    guild_id: guildId,
    role_id: roleId,
    unit_key: unitKey,
    roster_name: "Smoke Test Trooper",
    discord_display_name: "Smoke Test Trooper",
    assignment_priority: 50,
    create_player_if_missing: true
  })
});
console.log(JSON.stringify(applied, null, 2));
assertOk(applied, "assignment");

if (applied.player?.player_uid !== `discord:${discordUserId}`) {
  fail(`assignment created ${applied.player?.player_uid}, expected discord:${discordUserId}`);
}

if (applied.assignment?.assignment_source !== "discord") {
  fail(`assignment_source was ${applied.assignment?.assignment_source}, expected discord`);
}

if (applied.link?.discord_user_id !== discordUserId) {
  fail("assignment response did not include the Discord link");
}

console.log(`[smoke:discord-bot-assignment] OK discord_user_id=${discordUserId} unit_key=${unitKey}`);
