import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  appRoles,
  clearSessionCookie,
  createUserSession,
  hasRole,
  requireUser,
  revokeCurrentSession,
  setSessionCookie,
  type CurrentUser
} from "../auth.js";
import { getUserUnitRoles } from "../auth/units.js";
import { config } from "../config.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { withDbTransaction, type DbTransaction } from "../db/transactions.js";

const discordStartQuerySchema = z.object({
  redirect_after: z.string().max(500).optional()
});

const discordCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1)
});

const steamStartQuerySchema = z.object({
  redirect_after: z.string().max(500).optional()
});

const steamCallbackQuerySchema = z.record(z.string(), z.string());

const testLoginBodySchema = z.object({
  provider_user_id: z.string().min(1).max(64),
  display_name: z.string().min(1).max(200).default("Test Discord User"),
  avatar_url: z.string().url().nullable().optional(),
  roles: z.array(z.enum(appRoles)).max(appRoles.length).optional()
});

const testSteamLinkBodySchema = z.object({
  provider_user_id: z.string().min(1).max(64)
});

const selfPlayerBodySchema = z.object({
  display_name: z.string().trim().min(1).max(200)
});

type OAuthStateRow = {
  state: string;
  provider: "discord" | "steam";
  redirect_after: string | null;
  code_verifier: string | null;
  expires_at: Date;
  consumed_at: Date | null;
};

type DiscordTokenResponse = {
  access_token: string;
  token_type: string;
};

type DiscordProfile = {
  id: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
};

type UserIdentityRow = {
  user_id: string;
};

type AuthIdentityRow = {
  provider: "discord" | "steam";
  provider_user_id: string;
  display_name: string | null;
  last_seen_at: Date;
};

type AuthUserProfileRow = {
  display_name: string | null;
};

type LinkedPlayerRow = {
  player_uid: string;
  last_name: string | null;
  rank: string | null;
  roster_name: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
};

type SelfOperationRow = {
  operation_id: string;
  status: "started" | "finished" | "abandoned";
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  present_at_start: boolean;
  present_at_end: boolean;
};

type SelfSummaryRow = {
  operation_count: number;
  present_at_start_count: number;
  present_at_end_count: number;
  infantry_kills: number;
  vehicle_kills: number;
  player_kills: number;
  ai_kills: number;
  friendly_kills: number;
  deaths: number;
};

type OperationMateRow = {
  name: string | null;
  rank: string | null;
  role: string | null;
  side: string | null;
  group_name: string | null;
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

function sendAuthUnavailable(reply: FastifyReply, message = "Authentication provider is not configured.") {
  return reply.code(503).send({
    ok: false,
    error: {
      code: "auth_provider_unavailable",
      message
    }
  });
}

function sendProviderFailure(reply: FastifyReply, message = "Authentication provider rejected the request.") {
  return reply.code(502).send({
    ok: false,
    error: {
      code: "auth_provider_failure",
      message
    }
  });
}

function sendConflict(reply: FastifyReply, message: string) {
  return reply.code(409).send({
    ok: false,
    error: {
      code: "identity_conflict",
      message
    }
  });
}

function randomState(): string {
  return randomBytes(24).toString("base64url");
}

function isSafeRedirect(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  return value;
}

function discordAvatarUrl(profile: DiscordProfile): string | null {
  if (!profile.avatar) {
    return null;
  }

  return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`;
}

async function serializeUser(user: CurrentUser) {
  const unitMemberships = await getUserUnitRoles(user.id);
  const selfPlayerUids = await getSelfPlayerUids(user);
  const unitAdmin = unitMemberships.some((membership) => membership.role === "admin" || membership.role === "tcw_admin");
  const canViewSensitiveIdentifiers = hasRole(user, ["tcw_admin"]);

  return {
    id: user.id,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    roles: user.roles,
    unit_memberships: unitMemberships,
    units: unitMemberships.map((membership) => ({
      unit_id: membership.unit_id,
      slug: membership.unit_key,
      name: membership.name,
      roles: [membership.role]
    })),
    self_player_uids: selfPlayerUids,
    is_owner: user.roles.includes("owner"),
    is_tcw_admin: user.roles.includes("tcw_admin"),
    capabilities: {
      can_view_global_admin: hasRole(user, ["owner"]),
      can_view_sensitive_identifiers: canViewSensitiveIdentifiers,
      can_export: hasRole(user, ["tcw_admin"]) || hasRole(user, ["admin"]) || unitAdmin,
      can_manage_api_tokens: hasRole(user, ["owner"])
    },
    identities: user.identities.map((identity) => ({
      provider: identity.provider,
      provider_user_id: identity.provider_user_id,
      display_name: identity.display_name,
      avatar_url: identity.avatar_url
    }))
  };
}

async function getSelfPlayerUids(user: CurrentUser): Promise<string[]> {
  const steamId = user.identities.find((identity) => identity.provider === "steam")?.provider_user_id ?? null;
  const discordId = user.identities.find((identity) => identity.provider === "discord")?.provider_user_id ?? null;
  const result = await queryDb<{ player_uid: string }>(
    `
    SELECT DISTINCT p.player_uid
    FROM players p
    LEFT JOIN player_discord_links pdl ON pdl.player_uid = p.player_uid
    WHERE ($1::text IS NOT NULL AND p.player_uid = $1)
       OR ($2::text IS NOT NULL AND pdl.discord_user_id = $2)
    ORDER BY p.player_uid
    `,
    [steamId, discordId]
  );

  return result.rows.map((row) => row.player_uid);
}

async function findLinkedPlayer(user: CurrentUser): Promise<LinkedPlayerRow | null> {
  return findLinkedPlayerWithClient({ query: queryDb }, user);
}

async function findLinkedPlayerWithClient(client: DbTransaction, user: CurrentUser): Promise<LinkedPlayerRow | null> {
  const steamId = user.identities.find((identity) => identity.provider === "steam")?.provider_user_id ?? null;
  const discordId = user.identities.find((identity) => identity.provider === "discord")?.provider_user_id ?? null;

  const result = await client.query<LinkedPlayerRow>(
    `
    SELECT
      p.player_uid,
      p.last_name,
      up.rank,
      up.roster_name,
      p.first_seen_at,
      p.last_seen_at
    FROM players p
    LEFT JOIN unit_players up ON up.player_uid = p.player_uid
    LEFT JOIN player_discord_links pdl ON pdl.player_uid = p.player_uid
    WHERE ($1::text IS NOT NULL AND p.player_uid = $1)
       OR ($2::text IS NOT NULL AND pdl.discord_user_id = $2)
    ORDER BY p.last_seen_at DESC
    LIMIT 1
    `,
    [steamId, discordId]
  );

  return result.rows[0] ?? null;
}

async function updateSelfPlayerName(tx: DbTransaction, user: CurrentUser, displayName: string): Promise<LinkedPlayerRow | null> {
  await ensureAuthenticatedUserRosterEntry(tx, user.id);
  const player = await findLinkedPlayerWithClient(tx, user);

  if (!player) {
    return null;
  }

  await tx.query(
    `
    UPDATE players
    SET last_name = $2,
        updated_at = now()
    WHERE player_uid = $1
    `,
    [player.player_uid, displayName]
  );
  await tx.query(
    `
    UPDATE unit_players
    SET roster_name = $2,
        updated_at = now()
    WHERE player_uid = $1
    `,
    [player.player_uid, displayName]
  );
  await tx.query(
    `
    INSERT INTO admin_audit_events (actor_user_id, actor_label, action, target_user_id, details)
    VALUES ($1, 'self', 'update_player_name', $1, $2::jsonb)
    `,
    [user.id, JSON.stringify({ player_uid: player.player_uid, display_name: displayName })]
  );

  return {
    ...player,
    last_name: displayName,
    roster_name: displayName
  };
}

async function insertOAuthState(provider: "discord" | "steam", redirectAfter: string | null, codeVerifier: string | null) {
  const state = randomState();

  await queryDb(
    `
    INSERT INTO oauth_states (state, provider, redirect_after, code_verifier, expires_at)
    VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
    `,
    [state, provider, redirectAfter, codeVerifier]
  );

  return state;
}

async function consumeOAuthState(provider: "discord" | "steam", state: string): Promise<OAuthStateRow | null> {
  return withDbTransaction(async (tx) => {
    const result = await tx.query<OAuthStateRow>(
      `
      SELECT *
      FROM oauth_states
      WHERE state = $1
        AND provider = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      FOR UPDATE
      `,
      [state, provider]
    );
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    await tx.query("UPDATE oauth_states SET consumed_at = now() WHERE state = $1", [state]);
    return row;
  });
}

async function exchangeDiscordCode(code: string): Promise<DiscordTokenResponse> {
  if (!config.discordClientId || !config.discordClientSecret || !config.discordRedirectUri) {
    throw new Error("Discord OAuth is not configured.");
  }

  const body = new URLSearchParams({
    client_id: config.discordClientId,
    client_secret: config.discordClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.discordRedirectUri
  });

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    throw new Error(`Discord token exchange failed with HTTP ${response.status}.`);
  }

  return (await response.json()) as DiscordTokenResponse;
}

async function fetchDiscordProfile(token: DiscordTokenResponse): Promise<DiscordProfile> {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: {
      Authorization: `${token.token_type} ${token.access_token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Discord profile fetch failed with HTTP ${response.status}.`);
  }

  return (await response.json()) as DiscordProfile;
}

async function upsertDiscordUser(tx: DbTransaction, profile: DiscordProfile): Promise<string> {
  const displayName = profile.global_name ?? profile.username ?? `Discord ${profile.id}`;
  const avatarUrl = discordAvatarUrl(profile);
  const existingIdentity = await tx.query<UserIdentityRow>(
    "SELECT user_id FROM user_identities WHERE provider = 'discord' AND provider_user_id = $1",
    [profile.id]
  );
  const existingUserId = existingIdentity.rows[0]?.user_id;

  if (existingUserId) {
    await tx.query(
      `
      UPDATE app_users
      SET display_name = $2, avatar_url = $3, last_login_at = now(), updated_at = now()
      WHERE id = $1
      `,
      [existingUserId, displayName, avatarUrl]
    );
    await tx.query(
      `
      UPDATE user_identities
      SET display_name = $3, avatar_url = $4, raw_profile = $5::jsonb, last_seen_at = now()
      WHERE provider = 'discord' AND provider_user_id = $1 AND user_id = $2
      `,
      [profile.id, existingUserId, displayName, avatarUrl, JSON.stringify(profile)]
    );
    await ensureAuthenticatedUserRosterEntry(tx, existingUserId);
    return existingUserId;
  }

  const userResult = await tx.query<UserIdentityRow>(
    `
    INSERT INTO app_users (display_name, avatar_url, last_login_at)
    VALUES ($1, $2, now())
    RETURNING id AS user_id
    `,
    [displayName, avatarUrl]
  );
  const userId = userResult.rows[0]?.user_id;

  if (!userId) {
    throw new Error("User insert returned no row.");
  }

  await tx.query(
    `
    INSERT INTO user_identities (user_id, provider, provider_user_id, display_name, avatar_url, raw_profile)
    VALUES ($1, 'discord', $2, $3, $4, $5::jsonb)
    `,
    [userId, profile.id, displayName, avatarUrl, JSON.stringify(profile)]
  );

  await ensureAuthenticatedUserRosterEntry(tx, userId);
  return userId;
}

function getAuthPlayerUid(identity: AuthIdentityRow): string {
  if (identity.provider === "steam") {
    return identity.provider_user_id;
  }

  return `discord:${identity.provider_user_id}`;
}

function getAuthPlayerDisplayName(identities: AuthIdentityRow[], user: AuthUserProfileRow, chosenIdentity: AuthIdentityRow): string {
  const discordIdentity = identities.find((identity) => identity.provider === "discord");

  return (
    discordIdentity?.display_name ??
    user.display_name ??
    chosenIdentity.display_name ??
    `${chosenIdentity.provider} ${chosenIdentity.provider_user_id}`
  );
}

async function ensureAuthenticatedUserRosterEntry(tx: DbTransaction, userId: string): Promise<string | null> {
  const userResult = await tx.query<AuthUserProfileRow>(
    "SELECT display_name FROM app_users WHERE id = $1 AND disabled_at IS NULL",
    [userId]
  );
  const identitiesResult = await tx.query<AuthIdentityRow>(
    `
    SELECT provider, provider_user_id, display_name, last_seen_at
    FROM user_identities
    WHERE user_id = $1
    ORDER BY CASE WHEN provider = 'steam' THEN 0 ELSE 1 END, last_seen_at DESC
    `,
    [userId]
  );
  const user = userResult.rows[0];
  const identities = identitiesResult.rows;

  if (!user || identities.length === 0) {
    return null;
  }

  const chosenIdentity = identities[0];
  if (!chosenIdentity) {
    return null;
  }

  const playerUid = getAuthPlayerUid(chosenIdentity);
  const displayName = getAuthPlayerDisplayName(identities, user, chosenIdentity);
  const unitResult = await tx.query<{ id: string }>(
    `
    INSERT INTO units (unit_key, name, description)
    VALUES ('tcw', 'TCW', 'Default unit')
    ON CONFLICT (unit_key) DO UPDATE SET updated_at = now()
    RETURNING id
    `
  );
  const unitId = unitResult.rows[0]?.id;

  if (!unitId) {
    throw new Error("Default unit upsert returned no row.");
  }

  await tx.query(
    `
    INSERT INTO players (player_uid, last_name, raw_last_player)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (player_uid) DO UPDATE
    SET
      last_name = COALESCE(players.last_name, EXCLUDED.last_name),
      updated_at = now()
    `,
    [
      playerUid,
      displayName,
      JSON.stringify({
        source: "auth",
        user_id: userId,
        provider: chosenIdentity.provider,
        provider_user_id: chosenIdentity.provider_user_id,
        display_name: displayName
      })
    ]
  );
  await tx.query(
    `
    INSERT INTO unit_memberships (unit_id, user_id, role, grant_source)
    VALUES ($1, $2, 'member', 'auth-default')
    ON CONFLICT DO NOTHING
    `,
    [unitId, userId]
  );
  await tx.query(
    `
    INSERT INTO unit_players (unit_id, player_uid, roster_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (unit_id, player_uid) DO UPDATE
    SET
      roster_name = COALESCE(unit_players.roster_name, EXCLUDED.roster_name),
      is_active = true,
      updated_at = now()
    `,
    [unitId, playerUid, displayName]
  );

  const discordIdentity = identities.find((identity) => identity.provider === "discord");

  if (discordIdentity) {
    await tx.query(
      `
      INSERT INTO player_discord_links (
        player_uid, discord_user_id, discord_display_name, source, verified_at, raw_link
      )
      VALUES ($1, $2, $3, 'auth', now(), $4::jsonb)
      ON CONFLICT (discord_user_id) DO UPDATE
      SET
        player_uid = EXCLUDED.player_uid,
        discord_display_name = EXCLUDED.discord_display_name,
        source = EXCLUDED.source,
        verified_at = COALESCE(player_discord_links.verified_at, EXCLUDED.verified_at),
        raw_link = EXCLUDED.raw_link,
        updated_at = now()
      WHERE player_discord_links.source = 'auth'
      `,
      [
        playerUid,
        discordIdentity.provider_user_id,
        discordIdentity.display_name ?? user.display_name,
        JSON.stringify({ source: "auth", user_id: userId })
      ]
    );
  }

  const staleAuthPlayerUids = identities
    .filter((identity) => identity.provider === "discord")
    .map(getAuthPlayerUid)
    .filter((uid) => uid !== playerUid);

  if (staleAuthPlayerUids.length > 0) {
    await tx.query(
      `
      DELETE FROM players p
      WHERE p.player_uid = ANY($1::text[])
        AND p.raw_last_player->>'source' = 'auth'
        AND NOT EXISTS (
          SELECT 1 FROM operation_players op
          WHERE op.player_uid = p.player_uid
        )
      `,
      [staleAuthPlayerUids]
    );
  }

  return playerUid;
}

async function applyInitialAdminFallback(tx: DbTransaction, userId: string, discordId: string, request: FastifyRequest) {
  if (!config.initialAdminDiscordIds.includes(discordId)) {
    return;
  }

  request.log.warn("INITIAL_ADMIN_DISCORD_IDS is active; granting owner from env fallback");
  await tx.query(
    `
    INSERT INTO user_roles (user_id, role, grant_source)
    VALUES ($1, 'owner', 'env-bootstrap')
    ON CONFLICT (user_id, role) DO NOTHING
    `,
    [userId]
  );
  await tx.query(
    `
    INSERT INTO admin_audit_events (actor_label, action, target_user_id, details)
    VALUES ('system/env-bootstrap', 'grant_role', $1, $2::jsonb)
    `,
    [userId, JSON.stringify({ role: "owner", provider: "discord", provider_user_id: discordId })]
  );
}

async function upsertSteamIdentity(tx: DbTransaction, userId: string, steamId: string) {
  const existing = await tx.query<UserIdentityRow>(
    "SELECT user_id FROM user_identities WHERE provider = 'steam' AND provider_user_id = $1",
    [steamId]
  );
  const existingUserId = existing.rows[0]?.user_id;

  if (existingUserId && existingUserId !== userId) {
    throw new Error("steam_identity_conflict");
  }

  await tx.query(
    `
    INSERT INTO user_identities (user_id, provider, provider_user_id, display_name, raw_profile)
    VALUES ($1, 'steam', $2, $2, $3::jsonb)
    ON CONFLICT (user_id, provider) DO UPDATE
    SET provider_user_id = EXCLUDED.provider_user_id,
        display_name = EXCLUDED.display_name,
        raw_profile = EXCLUDED.raw_profile,
        last_seen_at = now()
    `,
    [userId, steamId, JSON.stringify({ steam_id: steamId })]
  );
  await ensureAuthenticatedUserRosterEntry(tx, userId);
  await tx.query(
    `
    INSERT INTO admin_audit_events (actor_user_id, actor_label, action, target_user_id, details)
    VALUES ($1, 'self', 'link_steam_identity', $1, $2::jsonb)
    `,
    [userId, JSON.stringify({ provider: "steam", provider_user_id: steamId })]
  );
}

function steamIdFromClaimedId(claimedId: string | undefined): string | null {
  const match = claimedId?.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/);
  return match?.[1] ?? null;
}

async function verifySteamCallback(query: Record<string, string>): Promise<boolean> {
  const params = new URLSearchParams(query);
  params.set("openid.mode", "check_authentication");

  const response = await fetch("https://steamcommunity.com/openid/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!response.ok) {
    return false;
  }

  const text = await response.text();
  return text.includes("is_valid:true");
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get("/auth/discord/start", async (request, reply) => {
    const parsedQuery = discordStartQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    if (!config.discordClientId || !config.discordRedirectUri) {
      return sendAuthUnavailable(reply, "Discord OAuth is not configured.");
    }

    try {
      const state = await insertOAuthState("discord", isSafeRedirect(parsedQuery.data.redirect_after), null);
      const authorizeUrl = new URL("https://discord.com/api/oauth2/authorize");
      authorizeUrl.searchParams.set("client_id", config.discordClientId);
      authorizeUrl.searchParams.set("redirect_uri", config.discordRedirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", "identify");
      authorizeUrl.searchParams.set("state", state);

      return reply.redirect(authorizeUrl.toString());
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to start Discord OAuth");
      return sendAuthUnavailable(reply);
    }
  });

  app.get("/auth/discord/callback", async (request, reply) => {
    const parsedQuery = discordCallbackQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    try {
      const state = await consumeOAuthState("discord", parsedQuery.data.state);

      if (!state) {
        return reply.code(400).send({ ok: false, error: { code: "invalid_oauth_state", message: "OAuth state is invalid or expired." } });
      }

      const token = await exchangeDiscordCode(parsedQuery.data.code);
      const profile = await fetchDiscordProfile(token);
      const userId = await withDbTransaction(async (tx) => {
        const nextUserId = await upsertDiscordUser(tx, profile);
        await applyInitialAdminFallback(tx, nextUserId, profile.id, request);
        return nextUserId;
      });
      const session = await createUserSession(userId, request);
      setSessionCookie(reply, session.token, session.expires_at);

      return reply.redirect(isSafeRedirect(state.redirect_after));
    } catch (error) {
      request.log.error({ err: error }, "Discord OAuth callback failed");
      return sendProviderFailure(reply);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    await revokeCurrentSession(request);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/v1/me", async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    return { ok: true, user: await serializeUser(user) };
  });

  app.get("/v1/me/player", async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    try {
      const player = await findLinkedPlayer(user);

      if (!player) {
        return {
          ok: true,
          linked_player: null,
          message: "Link Steam or ask an admin to link your player record."
        };
      }

      const summaryResult = await queryDb<SelfSummaryRow>(
        `
        SELECT
          COUNT(DISTINCT op.operation_id)::int AS operation_count,
          COUNT(*) FILTER (WHERE op.present_at_start = true)::int AS present_at_start_count,
          COUNT(*) FILTER (WHERE op.present_at_end = true)::int AS present_at_end_count,
          COALESCE(SUM(ops.infantry_kills), 0)::int AS infantry_kills,
          COALESCE(SUM(ops.vehicle_kills), 0)::int AS vehicle_kills,
          COALESCE(SUM(ops.player_kills), 0)::int AS player_kills,
          COALESCE(SUM(ops.ai_kills), 0)::int AS ai_kills,
          COALESCE(SUM(ops.friendly_kills), 0)::int AS friendly_kills,
          COALESCE(SUM(ops.deaths), 0)::int AS deaths
        FROM operation_players op
        LEFT JOIN operation_player_stats ops
          ON ops.operation_id = op.operation_id
          AND ops.player_uid = op.player_uid
        WHERE op.player_uid = $1
        `,
        [player.player_uid]
      );

      return {
        ok: true,
        linked_player: {
          display_name: player.roster_name ?? player.last_name,
          rank: player.rank,
          first_seen_at: player.first_seen_at,
          last_seen_at: player.last_seen_at
        },
        summary: summaryResult.rows[0] ?? {
          operation_count: 0,
          present_at_start_count: 0,
          present_at_end_count: 0,
          infantry_kills: 0,
          vehicle_kills: 0,
          player_kills: 0,
          ai_kills: 0,
          friendly_kills: 0,
          deaths: 0
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch self player");
      return reply.code(503).send({
        ok: false,
        error: { code: "database_unavailable", message: "Database is not available." }
      });
    }
  });

  app.patch("/v1/me/player", async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    const parsedBody = selfPlayerBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    try {
      const player = await withDbTransaction((tx) => updateSelfPlayerName(tx, user, parsedBody.data.display_name));

      if (!player) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "player_not_found",
            message: "Player was not found."
          }
        });
      }

      return {
        ok: true,
        linked_player: {
          display_name: player.roster_name ?? player.last_name,
          rank: player.rank,
          first_seen_at: player.first_seen_at,
          last_seen_at: player.last_seen_at
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update self player");
      return reply.code(503).send({
        ok: false,
        error: { code: "database_unavailable", message: "Database is not available." }
      });
    }
  });

  app.get("/v1/me/operations", async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    try {
      const player = await findLinkedPlayer(user);

      if (!player) {
        return {
          ok: true,
          linked_player: null,
          operations: [],
          message: "Link Steam or ask an admin to link your player record."
        };
      }

      const result = await queryDb<SelfOperationRow>(
        `
        SELECT
          o.id AS operation_id,
          o.status,
          o.mission_name,
          o.world_name,
          o.started_at,
          o.ended_at,
          op.present_at_start,
          op.present_at_end
        FROM operation_players op
        JOIN operations o ON o.id = op.operation_id
        WHERE op.player_uid = $1
        ORDER BY o.started_at DESC
        LIMIT 5
        `,
        [player.player_uid]
      );

      return {
        ok: true,
        linked_player: {
          display_name: player.roster_name ?? player.last_name,
          rank: player.rank
        },
        operations: result.rows
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch self operations");
      return reply.code(503).send({
        ok: false,
        error: { code: "database_unavailable", message: "Database is not available." }
      });
    }
  });

  app.get("/v1/me/operations/:operation_id", async (request, reply) => {
    const operationParamsSchema = z.object({
      operation_id: z.string().uuid()
    });
    const parsedParams = operationParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    try {
      const player = await findLinkedPlayer(user);

      if (!player) {
        return {
          ok: true,
          linked_player: null,
          operation: null,
          mates: [],
          message: "Link Steam or ask an admin to link your player record."
        };
      }

      const operationResult = await queryDb<SelfOperationRow>(
        `
        SELECT
          o.id AS operation_id,
          o.status,
          o.mission_name,
          o.world_name,
          o.started_at,
          o.ended_at,
          op.present_at_start,
          op.present_at_end
        FROM operation_players op
        JOIN operations o ON o.id = op.operation_id
        WHERE op.player_uid = $1
          AND op.operation_id = $2
        LIMIT 1
        `,
        [player.player_uid, parsedParams.data.operation_id]
      );
      const operation = operationResult.rows[0];

      if (!operation) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "operation_not_found",
            message: "Operation was not found for the linked player."
          }
        });
      }

      const mates = await queryDb<OperationMateRow>(
        `
        SELECT
          COALESCE(op.name_at_end, op.name_at_start, p.last_name) AS name,
          up.rank,
          COALESCE(op.role_at_end, op.role_at_start) AS role,
          COALESCE(op.side_at_end, op.side_at_start) AS side,
          COALESCE(op.group_at_end, op.group_at_start) AS group_name
        FROM operation_players op
        JOIN players p ON p.player_uid = op.player_uid
        LEFT JOIN unit_players up ON up.player_uid = op.player_uid
        WHERE op.operation_id = $1
          AND op.player_uid <> $2
        ORDER BY COALESCE(op.name_at_end, op.name_at_start, p.last_name)
        LIMIT 100
        `,
        [parsedParams.data.operation_id, player.player_uid]
      );

      return {
        ok: true,
        linked_player: {
          display_name: player.roster_name ?? player.last_name,
          rank: player.rank
        },
        operation,
        mates: mates.rows
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch self operation");
      return reply.code(503).send({
        ok: false,
        error: { code: "database_unavailable", message: "Database is not available." }
      });
    }
  });

  app.get("/v1/me/operation-mates", async (request, reply) => {
    const operationQuerySchema = z.object({
      operation_id: z.string().uuid()
    });
    const parsedQuery = operationQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    try {
      const player = await findLinkedPlayer(user);

      if (!player) {
        return {
          ok: true,
          linked_player: null,
          mates: [],
          message: "Link Steam or ask an admin to link your player record."
        };
      }

      const attended = await queryDb<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM operation_players
          WHERE operation_id = $1 AND player_uid = $2
        ) AS exists
        `,
        [parsedQuery.data.operation_id, player.player_uid]
      );

      if (!attended.rows[0]?.exists) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "operation_not_found",
            message: "Operation was not found for the linked player."
          }
        });
      }

      const mates = await queryDb<OperationMateRow>(
        `
        SELECT
          COALESCE(op.name_at_end, op.name_at_start, p.last_name) AS name,
          up.rank,
          COALESCE(op.role_at_end, op.role_at_start) AS role,
          COALESCE(op.side_at_end, op.side_at_start) AS side,
          COALESCE(op.group_at_end, op.group_at_start) AS group_name
        FROM operation_players op
        JOIN players p ON p.player_uid = op.player_uid
        LEFT JOIN unit_players up ON up.player_uid = op.player_uid
        WHERE op.operation_id = $1
          AND op.player_uid <> $2
        ORDER BY COALESCE(op.name_at_end, op.name_at_start, p.last_name)
        LIMIT 100
        `,
        [parsedQuery.data.operation_id, player.player_uid]
      );

      return { ok: true, mates: mates.rows };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch operation mates");
      return reply.code(503).send({
        ok: false,
        error: { code: "database_unavailable", message: "Database is not available." }
      });
    }
  });

  app.get("/auth/steam/start", async (request, reply) => {
    const parsedQuery = steamStartQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    if (!config.steamReturnUrl || !config.steamRealm) {
      return sendAuthUnavailable(reply, "Steam OpenID is not configured.");
    }

    const state = await insertOAuthState("steam", isSafeRedirect(parsedQuery.data.redirect_after), user.id);
    const steamUrl = new URL("https://steamcommunity.com/openid/login");
    steamUrl.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
    steamUrl.searchParams.set("openid.mode", "checkid_setup");
    steamUrl.searchParams.set("openid.return_to", `${config.steamReturnUrl}?state=${encodeURIComponent(state)}`);
    steamUrl.searchParams.set("openid.realm", config.steamRealm);
    steamUrl.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
    steamUrl.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");

    return reply.redirect(steamUrl.toString());
  });

  app.get("/auth/steam/callback", async (request, reply) => {
    const parsedQuery = steamCallbackQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const stateValue = parsedQuery.data.state;
    const state = stateValue ? await consumeOAuthState("steam", stateValue) : null;

    if (!state?.code_verifier) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_oauth_state", message: "OAuth state is invalid or expired." } });
    }

    const steamId = steamIdFromClaimedId(parsedQuery.data["openid.claimed_id"]);

    if (!steamId) {
      return sendValidationFailed(reply);
    }

    if (!(await verifySteamCallback(parsedQuery.data))) {
      return sendProviderFailure(reply, "Steam OpenID response could not be verified.");
    }

    try {
      await withDbTransaction(async (tx) => {
        await upsertSteamIdentity(tx, state.code_verifier ?? "", steamId);
      });
      return reply.redirect(isSafeRedirect(state.redirect_after));
    } catch (error) {
      if (error instanceof Error && error.message === "steam_identity_conflict") {
        return sendConflict(reply, "That Steam identity is already linked to another user.");
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to link Steam identity");
      return sendProviderFailure(reply);
    }
  });

  app.delete("/v1/me/identities/steam", async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    await withDbTransaction(async (tx) => {
      await tx.query("DELETE FROM user_identities WHERE user_id = $1 AND provider = 'steam'", [user.id]);
      await tx.query(
        `
        INSERT INTO admin_audit_events (actor_user_id, actor_label, action, target_user_id, details)
        VALUES ($1, 'self', 'unlink_steam_identity', $1, $2::jsonb)
        `,
        [user.id, JSON.stringify({ provider: "steam" })]
      );
    });

    return { ok: true };
  });

  app.post("/auth/test/login", async (request, reply) => {
    if (config.nodeEnv === "production" && !config.enableTestAuth) {
      return reply.code(404).send({ ok: false, error: { code: "not_found", message: "Route not found." } });
    }

    const parsedBody = testLoginBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const body = parsedBody.data;
    const userId = await withDbTransaction(async (tx) =>
      upsertDiscordUser(tx, {
        id: body.provider_user_id,
        username: body.display_name,
        global_name: body.display_name,
        avatar: null
      })
    );

    for (const role of body.roles ?? []) {
      await queryDb(
        `
        INSERT INTO user_roles (user_id, role, grant_source)
        VALUES ($1, $2, 'test_auth')
        ON CONFLICT (user_id, role) DO UPDATE
        SET grant_source = EXCLUDED.grant_source,
            granted_at = now()
        `,
        [userId, role]
      );
    }

    const session = await createUserSession(userId, request);
    setSessionCookie(reply, session.token, session.expires_at);

    return { ok: true, user_id: userId };
  });

  app.post("/auth/test/link-steam", async (request, reply) => {
    if (config.nodeEnv === "production" && !config.enableTestAuth) {
      return reply.code(404).send({ ok: false, error: { code: "not_found", message: "Route not found." } });
    }

    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    const parsedBody = testSteamLinkBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    try {
      await withDbTransaction(async (tx) => {
        await upsertSteamIdentity(tx, user.id, parsedBody.data.provider_user_id);
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === "steam_identity_conflict") {
        return sendConflict(reply, "That Steam identity is already linked to another user.");
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to link test Steam identity");
      return sendProviderFailure(reply);
    }
  });
}
