import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  appRoles,
  clearSessionCookie,
  createUserSession,
  hasRole,
  loadCurrentUserById,
  requireUser,
  revokeCurrentSession,
  setSessionCookie,
  type CurrentUser
} from "../auth.js";
import { createCsrfToken } from "../auth/csrf.js";
import {
  consumeJwtHandoffCode,
  createJwtHandoffCode,
  isJwtAuthEnabled,
  issueAccessJwt,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken
} from "../auth/jwt.js";
import { getSafeReturnTo } from "../auth/redirects.js";
import { getUserUnitRoles } from "../auth/units.js";
import { config } from "../config.js";
import {
  DiscordAuthPolicyError,
  getDiscordDisplayNamePolicy,
  getLoginGrantGuildIds,
  getLoginGuildDisplayNameOrder
} from "../config/discordAuth.js";
import {
  DiscordRateLimitError,
  fetchCurrentUserGuildMember,
  type DiscordCurrentGuildMember,
  type DiscordOAuthToken
} from "../discord/client.js";
import {
  choosePreferredDiscordDisplayName,
  type PreferredDiscordDisplayName
} from "../discord/displayName.js";
import {
  reconcileDiscordMembership,
  upsertDiscordMemberSnapshot
} from "../discord/membershipResolver.js";
import { resolveDiscordLinkedPlayerUid } from "../discord/playerAssignment.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { playerDiscordLinks } from "../db/schema/discord.js";
import { operations } from "../db/schema/operations.js";
import { operationPlayers, players } from "../db/schema/players.js";
import { unitPlayers, unitRanks, units } from "../db/schema/units.js";
import { withDbTransaction, type DbTransaction } from "../db/transactions.js";

const discordStartQuerySchema = z.object({
  mode: z.enum(["cookie", "jwt"]).default("cookie"),
  return_to: z.string().max(1000).optional(),
  redirect_after: z.string().max(500).optional()
});

const discordCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1)
});

const steamStartQuerySchema = z.object({
  return_to: z.string().max(1000).optional(),
  redirect_after: z.string().max(500).optional()
});

const steamLinkTicketBodySchema = z.object({
  return_to: z.string().max(1000).optional(),
  redirect_after: z.string().max(500).optional()
});

const steamStartTicketQuerySchema = z.object({
  ticket: z.string().min(32).max(256)
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

const jwtExchangeCodeFieldsSchema = z.object({
  handoff_code: z.string().min(1).max(256).optional(),
  auth_handoff: z.string().min(1).max(256).optional(),
  code: z.string().min(1).max(256).optional()
});

const jwtExchangeBodySchema = jwtExchangeCodeFieldsSchema;
const jwtExchangeQuerySchema = jwtExchangeCodeFieldsSchema;

const jwtRefreshBodySchema = z.object({
  refresh_token: z.string().min(32).max(512)
});

const testJwtHandoffBodySchema = z.object({
  return_to: z.string().max(1000).optional()
});

const selfPlayerBodySchema = z.object({
  display_name: z.string().trim().min(1).max(200)
});

type OAuthStateRow = {
  state: string;
  provider: "discord" | "steam";
  redirect_after: string | null;
  code_verifier: string | null;
  flow_mode: "cookie" | "jwt";
  expires_at: Date;
  consumed_at: Date | null;
};

type AuthLinkTicketRow = {
  user_id: string;
  return_to: string;
};

type DiscordTokenResponse = DiscordOAuthToken;

type DiscordProfile = {
  id: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
};

class DiscordTokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordTokenExchangeError";
  }
}

class DiscordProfileFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordProfileFetchError";
  }
}

class DiscordMembershipFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordMembershipFetchError";
  }
}

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

type LinkedPlayerReason =
  | "no_steam_or_discord_identity"
  | "steam_identity_linked_but_player_missing"
  | "discord_identity_linked_but_player_missing"
  | "linked_player_found";

type LinkedPlayerState = {
  steam_linked: boolean;
  steam_id: string | null;
  discord_linked: boolean;
  discord_id: string | null;
  has_discord_player_link: boolean;
  reason: LinkedPlayerReason;
};

type SelfUnitMembershipRow = {
  unit_id: string;
  unit_key: string;
  name: string;
  display_name: string | null;
  callsign: string | null;
  rank: string | null;
  roster_name: string | null;
  roster_status: string;
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
  soft_vehicle_kills: number;
  armor_kills: number;
  air_kills: number;
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

function sendJwtAuthDisabled(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: {
      code: "jwt_auth_disabled",
      message: "JWT authentication is not enabled."
    }
  });
}

function sendJwtUnauthorized(reply: FastifyReply, message = "JWT credentials are invalid or expired.") {
  return reply.code(401).send({
    ok: false,
    error: {
      code: "jwt_unauthorized",
      message
    }
  });
}

function sendInvalidHandoffRequest(reply: FastifyReply) {
  return reply.code(400).send({
    ok: false,
    error: {
      code: "invalid_handoff_request",
      message: "Expected JSON body containing handoff_code, auth_handoff, or code."
    }
  });
}

function sendExpiredOrConsumedHandoff(reply: FastifyReply) {
  return reply.code(401).send({
    ok: false,
    error: {
      code: "handoff_code_expired_or_consumed",
      message: "The authentication handoff code is expired, invalid, or already used."
    }
  });
}

function sendDiscordRateLimited(reply: FastifyReply, retryAfterSeconds: number) {
  return reply.code(429).send({
    ok: false,
    error: {
      code: "discord_rate_limited",
      message: "Discord is rate-limiting login verification. Please try again shortly.",
      retry_after_seconds: retryAfterSeconds
    }
  });
}

function randomState(): string {
  return randomBytes(24).toString("base64url");
}

function discordAvatarUrl(profile: DiscordProfile): string | null {
  if (!profile.avatar) {
    return null;
  }

  return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`;
}

function objectKeys(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value as Record<string, unknown>) : [];
}

function getHandoffCode(body: unknown, query: unknown): string | null {
  const parsedBody = jwtExchangeBodySchema.safeParse(body);

  if (parsedBody.success) {
    const bodyCode = parsedBody.data.handoff_code ?? parsedBody.data.auth_handoff ?? parsedBody.data.code ?? null;

    if (bodyCode) {
      return bodyCode;
    }
  }

  const parsedQuery = jwtExchangeQuerySchema.safeParse(query);

  if (parsedQuery.success) {
    return parsedQuery.data.handoff_code ?? parsedQuery.data.auth_handoff ?? parsedQuery.data.code ?? null;
  }

  return null;
}

function linkedIdentities(user: CurrentUser) {
  const discord = user.identities.find((identity) => identity.provider === "discord") ?? null;
  const steam = user.identities.find((identity) => identity.provider === "steam") ?? null;

  return {
    discord: {
      linked: Boolean(discord),
      id: discord?.provider_user_id ?? null,
      display_name: discord?.display_name ?? null
    },
    steam: {
      linked: Boolean(steam),
      steam_id: steam?.provider_user_id ?? null,
      display_name: steam?.display_name ?? null
    }
  };
}

async function serializeUser(user: CurrentUser) {
  const unitMemberships = await getUserUnitRoles(user.id);
  const selfPlayerUids = await getSelfPlayerUids(user);
  const unitAdmin = unitMemberships.some((membership) => membership.role === "admin" || membership.role === "tcw_admin");
  const canViewSensitiveIdentifiers = hasRole(user, ["tcw_admin"]);
  const linked = linkedIdentities(user);

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
    linked_identities: linked,
    steam_linked: linked.steam.linked,
    discord_linked: linked.discord.linked,
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

function getIdentityIds(user: CurrentUser): { steamId: string | null; discordId: string | null } {
  return {
    steamId: user.identities.find((identity) => identity.provider === "steam")?.provider_user_id ?? null,
    discordId: user.identities.find((identity) => identity.provider === "discord")?.provider_user_id ?? null
  };
}

async function getSelfPlayerUids(user: CurrentUser): Promise<string[]> {
  const steamId = user.identities.find((identity) => identity.provider === "steam")?.provider_user_id ?? null;
  const discordId = user.identities.find((identity) => identity.provider === "discord")?.provider_user_id ?? null;

  const result = await getDrizzleDb().execute<{ player_uid: string }>(sql`
    SELECT DISTINCT p.player_uid
    FROM players p
    LEFT JOIN player_discord_links pdl ON pdl.player_uid = p.player_uid
    WHERE p.deleted_at IS NULL
      AND (
        (${steamId}::text IS NOT NULL AND p.player_uid = ${steamId})
        OR (${discordId}::text IS NOT NULL AND pdl.discord_user_id = ${discordId})
      )
    ORDER BY p.player_uid
  `);

  return result.rows.map((row) => row.player_uid);
}

async function findLinkedPlayer(user: CurrentUser): Promise<LinkedPlayerRow | null> {
  const steamId = user.identities.find((identity) => identity.provider === "steam")?.provider_user_id ?? null;
  const discordId = user.identities.find((identity) => identity.provider === "discord")?.provider_user_id ?? null;
  const rows = await getDrizzleDb()
    .select({
      player_uid: players.playerUid,
      last_name: players.lastName,
      rank: sql<string | null>`COALESCE(${unitRanks.name}, ${unitPlayers.rank})`,
      roster_name: unitPlayers.rosterName,
      first_seen_at: players.firstSeenAt,
      last_seen_at: players.lastSeenAt
    })
    .from(players)
    .leftJoin(
      unitPlayers,
      and(eq(unitPlayers.playerUid, players.playerUid), eq(unitPlayers.isActive, true), ne(unitPlayers.rosterStatus, "inactive"))
    )
    .leftJoin(unitRanks, eq(unitRanks.id, unitPlayers.rankId))
    .leftJoin(playerDiscordLinks, eq(playerDiscordLinks.playerUid, players.playerUid))
    .where(
      and(
        isNull(players.deletedAt),
        or(
          and(sql`${steamId}::text IS NOT NULL`, eq(players.playerUid, steamId ?? "")),
          and(sql`${discordId}::text IS NOT NULL`, eq(playerDiscordLinks.discordUserId, discordId ?? ""))
        )
      )
    )
    .orderBy(desc(players.lastSeenAt))
    .limit(1);

  return rows[0] ?? null;
}

async function findLinkedPlayerWithClient(client: DbTransaction, user: CurrentUser): Promise<LinkedPlayerRow | null> {
  const steamId = user.identities.find((identity) => identity.provider === "steam")?.provider_user_id ?? null;
  const discordId = user.identities.find((identity) => identity.provider === "discord")?.provider_user_id ?? null;

  const result = await client.query<LinkedPlayerRow>(
    `
    SELECT
      p.player_uid,
      p.last_name,
      COALESCE(ur.name, up.rank) AS rank,
      up.roster_name,
      p.first_seen_at,
      p.last_seen_at
    FROM players p
    LEFT JOIN unit_players up
      ON up.player_uid = p.player_uid
      AND up.is_active = true
      AND up.roster_status <> 'inactive'
    LEFT JOIN unit_ranks ur ON ur.id = up.rank_id
    LEFT JOIN player_discord_links pdl ON pdl.player_uid = p.player_uid
    WHERE p.deleted_at IS NULL
      AND (
        ($1::text IS NOT NULL AND p.player_uid = $1)
        OR ($2::text IS NOT NULL AND pdl.discord_user_id = $2)
      )
    ORDER BY p.last_seen_at DESC
    LIMIT 1
    `,
    [steamId, discordId]
  );

  return result.rows[0] ?? null;
}

async function hasDiscordPlayerLink(discordId: string | null): Promise<boolean> {
  if (!discordId) {
    return false;
  }

  const result = await queryDb<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM player_discord_links WHERE discord_user_id = $1) AS exists",
    [discordId]
  );

  return result.rows[0]?.exists ?? false;
}

async function getLinkedPlayerState(user: CurrentUser, player: LinkedPlayerRow | null): Promise<LinkedPlayerState> {
  const { steamId, discordId } = getIdentityIds(user);
  const hasDiscordLink = await hasDiscordPlayerLink(discordId);
  const reason: LinkedPlayerReason = player
    ? "linked_player_found"
    : steamId
      ? "steam_identity_linked_but_player_missing"
      : discordId
        ? "discord_identity_linked_but_player_missing"
        : "no_steam_or_discord_identity";

  return {
    steam_linked: Boolean(steamId),
    steam_id: steamId,
    discord_linked: Boolean(discordId),
    discord_id: discordId,
    has_discord_player_link: hasDiscordLink,
    reason
  };
}

async function findLinkedPlayerWithRepair(user: CurrentUser): Promise<{ player: LinkedPlayerRow | null; linkState: LinkedPlayerState }> {
  let player = await findLinkedPlayer(user);
  const { steamId } = getIdentityIds(user);

  if (!player && steamId) {
    await withDbTransaction((tx) => ensureAuthenticatedUserRosterEntry(tx, user.id));
    player = await findLinkedPlayer(user);
  }

  return {
    player,
    linkState: await getLinkedPlayerState(user, player)
  };
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

function requestUserAgent(request: FastifyRequest): string | null {
  const userAgent = request.headers["user-agent"];
  return Array.isArray(userAgent) ? (userAgent[0] ?? null) : (userAgent ?? null);
}

function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateLinkTicket(): string {
  return `aat_link_${randomBytes(32).toString("base64url")}`;
}

async function createSteamLinkTicket(userId: string, returnTo: string, request: FastifyRequest): Promise<{ ticket: string; expires_at: Date }> {
  const ticket = generateLinkTicket();
  const result = await queryDb<{ expires_at: Date }>(
    `
    INSERT INTO auth_link_tickets (ticket_hash, user_id, purpose, return_to, expires_at, ip_address, user_agent)
    VALUES ($1, $2, 'steam_link', $3, now() + ($4::int * interval '1 second'), $5, $6)
    RETURNING expires_at
    `,
    [hashOpaqueToken(ticket), userId, returnTo, config.jwtHandoffTtlSeconds, request.ip, requestUserAgent(request)]
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("Steam link ticket insert returned no row.");
  }

  return { ticket, expires_at: row.expires_at };
}

async function consumeSteamLinkTicket(tx: DbTransaction, ticket: string): Promise<AuthLinkTicketRow | null> {
  const result = await tx.query<AuthLinkTicketRow>(
    `
    UPDATE auth_link_tickets
    SET consumed_at = now()
    WHERE ticket_hash = $1
      AND purpose = 'steam_link'
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING user_id, return_to
    `,
    [hashOpaqueToken(ticket)]
  );

  return result.rows[0] ?? null;
}

function steamStartTicketUrl(ticket: string): string {
  const url = new URL("/auth/steam/start-ticket", config.publicBaseUrl);
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

function steamLinkedReturnTo(returnTo: string | null): string {
  const url = new URL(getSafeReturnTo(returnTo), config.publicBaseUrl);
  url.searchParams.set("steam_linked", "1");
  return url.toString();
}

function steamOpenIdUrl(state: string): string {
  if (!config.steamReturnUrl || !config.steamRealm) {
    throw new Error("steam_openid_not_configured");
  }

  const steamUrl = new URL("https://steamcommunity.com/openid/login");
  steamUrl.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
  steamUrl.searchParams.set("openid.mode", "checkid_setup");
  steamUrl.searchParams.set("openid.return_to", `${config.steamReturnUrl}?state=${encodeURIComponent(state)}`);
  steamUrl.searchParams.set("openid.realm", config.steamRealm);
  steamUrl.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
  steamUrl.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");

  return steamUrl.toString();
}

async function insertOAuthState(
  provider: "discord" | "steam",
  redirectAfter: string | null,
  codeVerifier: string | null,
  flowMode: "cookie" | "jwt" = "cookie"
) {
  const state = randomState();

  await queryDb(
    `
    INSERT INTO oauth_states (state, provider, redirect_after, code_verifier, flow_mode, expires_at)
    VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')
    `,
    [state, provider, redirectAfter, codeVerifier, flowMode]
  );

  return state;
}

async function insertOAuthStateWithClient(
  tx: DbTransaction,
  provider: "discord" | "steam",
  redirectAfter: string | null,
  codeVerifier: string | null,
  flowMode: "cookie" | "jwt" = "cookie"
) {
  const state = randomState();

  await tx.query(
    `
    INSERT INTO oauth_states (state, provider, redirect_after, code_verifier, flow_mode, expires_at)
    VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')
    `,
    [state, provider, redirectAfter, codeVerifier, flowMode]
  );

  return state;
}

function appendAuthHandoff(returnTo: string, handoffCode: string): string {
  const redirectUrl = new URL(returnTo, config.publicBaseUrl);
  redirectUrl.searchParams.set("auth_handoff", handoffCode);
  return redirectUrl.toString();
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
    throw new DiscordTokenExchangeError(`Discord token exchange failed with HTTP ${response.status}.`);
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
    throw new DiscordProfileFetchError(`Discord profile fetch failed with HTTP ${response.status}.`);
  }

  return (await response.json()) as DiscordProfile;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCurrentUserGuildMemberWithRetry(
  token: DiscordTokenResponse,
  guildId: string
): Promise<DiscordCurrentGuildMember | null> {
  try {
    return await fetchCurrentUserGuildMember(token, guildId);
  } catch (error) {
    if (error instanceof DiscordRateLimitError && error.retryAfterSeconds <= 3) {
      await sleep(error.retryAfterSeconds * 1000);
      return fetchCurrentUserGuildMember(token, guildId);
    }

    throw error;
  }
}

function cachedMemberFromRow(row: {
  role_ids: unknown;
  nick: string | null;
  joined_at: Date | string | null;
  member_payload: unknown;
}): DiscordCurrentGuildMember {
  const payload =
    typeof row.member_payload === "object" && row.member_payload !== null
      ? (row.member_payload as Partial<DiscordCurrentGuildMember>)
      : {};
  const roles = Array.isArray(row.role_ids) ? row.role_ids.filter((role): role is string => typeof role === "string") : [];

  return {
    ...payload,
    roles: Array.isArray(payload.roles) ? payload.roles : roles,
    nick: payload.nick ?? row.nick,
    joined_at: payload.joined_at ?? (row.joined_at instanceof Date ? row.joined_at.toISOString() : row.joined_at)
  };
}

async function getCachedDiscordGuildMember(
  discordUserId: string,
  guildId: string
): Promise<DiscordCurrentGuildMember | null> {
  const result = await queryDb<{
    role_ids: unknown;
    nick: string | null;
    joined_at: Date | null;
    member_payload: unknown;
  }>(
    `
    SELECT role_ids, nick, joined_at, member_payload
    FROM discord_member_snapshots
    WHERE discord_user_id = $1
      AND guild_id = $2
      AND last_seen_at >= now() - ($3::int * interval '1 minute')
    ORDER BY last_seen_at DESC
    LIMIT 1
    `,
    [discordUserId, guildId, config.discordAuthReconcileStaleAfterMinutes]
  );
  const row = result.rows[0];

  return row ? cachedMemberFromRow(row) : null;
}

async function fetchDiscordLoginGuildMemberships(
  token: DiscordTokenResponse,
  discordUserId: string,
  request: FastifyRequest
): Promise<Array<{ guildId: string; member: DiscordCurrentGuildMember }>> {
  if (!config.discordAuthEnabled) {
    return [];
  }

  const guildIds = getLoginGrantGuildIds();

  if (guildIds.length === 0) {
    if (config.discordAuthRequireGuild) {
      throw new DiscordAuthPolicyError("No Discord login guilds are configured.");
    }

    return [];
  }

  const memberships: Array<{ guildId: string; member: DiscordCurrentGuildMember }> = [];

  for (const guildId of guildIds) {
    try {
      const member = await fetchCurrentUserGuildMemberWithRetry(token, guildId);

      if (member) {
        memberships.push({ guildId, member });
      }
    } catch (error) {
      if (error instanceof DiscordRateLimitError) {
        const cachedMember = await getCachedDiscordGuildMember(discordUserId, guildId);

        if (cachedMember) {
          request.log.warn(
            { guildId, retryAfterSeconds: error.retryAfterSeconds },
            "Using cached Discord membership snapshot after rate limit"
          );
          memberships.push({ guildId, member: cachedMember });
          continue;
        }
      }

      if (error instanceof DiscordRateLimitError || error instanceof DiscordMembershipFetchError) {
        throw error;
      }

      throw new DiscordMembershipFetchError(error instanceof Error ? error.message : "Discord membership fetch failed.");
    }
  }

  return memberships;
}

function sendDiscordGuildMembershipRequired(reply: FastifyReply) {
  return reply.code(403).send({
    ok: false,
    error: {
      code: "discord_guild_membership_required",
      message: "Discord login requires membership in an approved guild."
    }
  });
}

async function upsertDiscordUser(
  tx: DbTransaction,
  profile: DiscordProfile,
  preferredName?: PreferredDiscordDisplayName
): Promise<string> {
  const displayName = preferredName?.displayName ?? profile.global_name ?? profile.username ?? `Discord ${profile.id}`;
  const avatarUrl = discordAvatarUrl(profile);
  const rawProfile = {
    ...profile,
    ...(preferredName
      ? {
          preferred_display_name: {
            display_name: preferredName.displayName,
            source: preferredName.source,
            guild_id: preferredName.guildId
          }
        }
      : {})
  };
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
      [profile.id, existingUserId, displayName, avatarUrl, JSON.stringify(rawProfile)]
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
    [userId, profile.id, displayName, avatarUrl, JSON.stringify(rawProfile)]
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

async function resolveAuthPlayerUid(tx: DbTransaction, identities: AuthIdentityRow[]): Promise<string | null> {
  const steamIdentity = identities.find((identity) => identity.provider === "steam");

  if (steamIdentity) {
    return steamIdentity.provider_user_id;
  }

  const discordIdentity = identities.find((identity) => identity.provider === "discord");

  if (!discordIdentity) {
    return null;
  }

  return (await resolveDiscordLinkedPlayerUid(tx, discordIdentity.provider_user_id)) ?? getAuthPlayerUid(discordIdentity);
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

  const playerUid = await resolveAuthPlayerUid(tx, identities);

  if (!playerUid) {
    return null;
  }

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
      last_name = CASE
        WHEN players.raw_last_player->>'source' = 'auth'
          OR players.last_name IS NULL
          OR btrim(players.last_name) = ''
        THEN EXCLUDED.last_name
        ELSE players.last_name
      END,
      deleted_at = NULL,
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
    INSERT INTO unit_players (unit_id, player_uid, roster_name, assignment_source)
    VALUES ($1, $2, $3, 'auth-default')
    ON CONFLICT (unit_id, player_uid) DO UPDATE
    SET
      roster_name = CASE
        WHEN unit_players.roster_name IS NULL
          OR btrim(unit_players.roster_name) = ''
          OR unit_players.assignment_source IN ('auth', 'auth-default')
        THEN EXCLUDED.roster_name
        ELSE unit_players.roster_name
      END,
      is_active = true,
      assignment_source = CASE
        WHEN unit_players.assignment_source = 'manual' THEN unit_players.assignment_source
        ELSE EXCLUDED.assignment_source
      END,
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
        player_uid = CASE
          WHEN player_discord_links.source = 'auth' THEN EXCLUDED.player_uid
          ELSE player_discord_links.player_uid
        END,
        discord_display_name = CASE
          WHEN player_discord_links.source = 'auth'
            OR player_discord_links.discord_display_name IS NULL
            OR btrim(player_discord_links.discord_display_name) = ''
          THEN EXCLUDED.discord_display_name
          ELSE player_discord_links.discord_display_name
        END,
        source = CASE
          WHEN player_discord_links.source = 'auth' THEN EXCLUDED.source
          ELSE player_discord_links.source
        END,
        verified_at = COALESCE(player_discord_links.verified_at, EXCLUDED.verified_at),
        raw_link = player_discord_links.raw_link || EXCLUDED.raw_link,
        updated_at = now()
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
  app.get("/auth/discord/start", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsedQuery = discordStartQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    if (!config.discordClientId || !config.discordRedirectUri) {
      return sendAuthUnavailable(reply, "Discord OAuth is not configured.");
    }

    if (parsedQuery.data.mode === "jwt" && !isJwtAuthEnabled()) {
      return sendJwtAuthDisabled(reply);
    }

    try {
      const state = await insertOAuthState(
        "discord",
        getSafeReturnTo(parsedQuery.data.return_to ?? parsedQuery.data.redirect_after),
        null,
        parsedQuery.data.mode
      );
      const authorizeUrl = new URL("https://discord.com/api/oauth2/authorize");
      authorizeUrl.searchParams.set("client_id", config.discordClientId);
      authorizeUrl.searchParams.set("redirect_uri", config.discordRedirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", config.discordAuthEnabled ? "identify guilds.members.read" : "identify");
      authorizeUrl.searchParams.set("state", state);

      return reply.redirect(authorizeUrl.toString());
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to start Discord OAuth");
      return sendAuthUnavailable(reply);
    }
  });

  app.get("/auth/discord/callback", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
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
      const memberships = await fetchDiscordLoginGuildMemberships(token, profile.id, request);
      const preferredName = choosePreferredDiscordDisplayName({
        profile,
        memberships,
        policy: getDiscordDisplayNamePolicy(),
        guildOrder: getLoginGuildDisplayNameOrder()
      });

      if (config.discordAuthEnabled && config.discordAuthRequireGuild && memberships.length === 0) {
        return sendDiscordGuildMembershipRequired(reply);
      }

      request.log.info(
        {
          discordUserId: profile.id,
          preferredDisplayNameSource: preferredName.source,
          preferredDisplayNameGuildId: preferredName.guildId
        },
        "Selected Discord display name"
      );

      const userId = await withDbTransaction(async (tx) => {
        const nextUserId = await upsertDiscordUser(tx, profile, preferredName);
        await applyInitialAdminFallback(tx, nextUserId, profile.id, request);
        return nextUserId;
      });

      for (const membership of memberships) {
        await upsertDiscordMemberSnapshot({
          guildId: membership.guildId,
          discordUserId: profile.id,
          userId,
          roles: membership.member.roles,
          nick: membership.member.nick ?? null,
          joinedAt: membership.member.joined_at ?? null,
          rawMember: membership.member as unknown as Record<string, unknown>,
          source: "oauth_login"
        });
      }

      if (config.discordAuthEnabled && config.discordAuthReconcileOnLogin) {
        const reconciliation = await reconcileDiscordMembership({
          userId,
          discordUserId: profile.id,
          dryRun: false,
          source: "oauth_login"
        });

        if (reconciliation.denied) {
          return sendDiscordGuildMembershipRequired(reply);
        }
      }

      if (state.flow_mode === "jwt") {
        if (!isJwtAuthEnabled()) {
          return sendJwtAuthDisabled(reply);
        }

        const returnTo = getSafeReturnTo(state.redirect_after);
        const handoff = await createJwtHandoffCode(userId, returnTo, request);
        return reply.redirect(appendAuthHandoff(returnTo, handoff.code));
      }

      const session = await createUserSession(userId, request);
      setSessionCookie(reply, session.token, session.expires_at);
      return reply.redirect(getSafeReturnTo(state.redirect_after));
    } catch (error) {
      request.log.error({ err: error }, "Discord OAuth callback failed");

      if (error instanceof DiscordRateLimitError) {
        return sendDiscordRateLimited(reply, error.retryAfterSeconds);
      }

      if (error instanceof DiscordTokenExchangeError) {
        return reply.code(502).send({
          ok: false,
          error: {
            code: "discord_token_exchange_failed",
            message: "Discord token exchange failed."
          }
        });
      }

      if (error instanceof DiscordProfileFetchError) {
        return reply.code(502).send({
          ok: false,
          error: {
            code: "discord_profile_fetch_failed",
            message: "Discord profile fetch failed."
          }
        });
      }

      if (error instanceof DiscordAuthPolicyError) {
        return reply.code(503).send({
          ok: false,
          error: {
            code: "discord_auth_policy_unavailable",
            message: "Discord auth policy is not configured."
          }
        });
      }

      if (error instanceof DiscordMembershipFetchError) {
        return reply.code(502).send({
          ok: false,
          error: {
            code: "discord_membership_fetch_failed",
            message: "Discord guild membership verification failed."
          }
        });
      }

      return sendProviderFailure(reply);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    await revokeCurrentSession(request);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/auth/jwt/exchange", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!isJwtAuthEnabled()) {
      return sendJwtAuthDisabled(reply);
    }

    const handoffCode = getHandoffCode(request.body, request.query);

    if (!handoffCode) {
      request.log.warn(
        {
          hasBody: Boolean(request.body),
          bodyKeys: objectKeys(request.body),
          queryKeys: objectKeys(request.query)
        },
        "JWT handoff exchange request missing supported code field"
      );
      return sendInvalidHandoffRequest(reply);
    }

    try {
      const handoff = await consumeJwtHandoffCode(handoffCode);

      if (!handoff) {
        return sendExpiredOrConsumedHandoff(reply);
      }

      const user = await loadCurrentUserById(handoff.user_id);

      if (!user) {
        return sendJwtUnauthorized(reply);
      }

      const [accessToken, refreshToken] = await Promise.all([
        issueAccessJwt(user.id),
        issueRefreshToken(user.id, request)
      ]);

      return {
        ok: true,
        token_type: "Bearer",
        access_token: accessToken,
        expires_in: config.jwtAccessTtlSeconds,
        refresh_token: refreshToken.token,
        user: await serializeUser(user)
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to exchange JWT handoff");
      return reply.code(502).send({
        ok: false,
        error: {
          code: "jwt_handoff_failed",
          message: "JWT handoff exchange failed."
        }
      });
    }
  });

  app.post("/auth/jwt/refresh", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!isJwtAuthEnabled()) {
      return sendJwtAuthDisabled(reply);
    }

    const parsedBody = jwtRefreshBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    try {
      const rotated = await rotateRefreshToken(parsedBody.data.refresh_token, request);

      if (!rotated) {
        return sendJwtUnauthorized(reply, "Refresh token is invalid or expired.");
      }

      const user = await loadCurrentUserById(rotated.user_id);

      if (!user) {
        await revokeRefreshToken(rotated.refresh_token.token);
        return sendJwtUnauthorized(reply);
      }

      return {
        ok: true,
        token_type: "Bearer",
        access_token: await issueAccessJwt(user.id),
        expires_in: config.jwtAccessTtlSeconds,
        refresh_token: rotated.refresh_token.token,
        user: await serializeUser(user)
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to refresh JWT auth");
      return sendProviderFailure(reply, "JWT refresh failed.");
    }
  });

  app.post("/auth/jwt/logout", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!isJwtAuthEnabled()) {
      return sendJwtAuthDisabled(reply);
    }

    const parsedBody = jwtRefreshBodySchema.safeParse(request.body);

    if (parsedBody.success) {
      await revokeRefreshToken(parsedBody.data.refresh_token);
    }

    return { ok: true };
  });

  app.get("/v1/me", async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    return { ok: true, user: await serializeUser(user) };
  });

  app.get("/auth/csrf", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    if (user.session_id === "jwt") {
      return {
        ok: true,
        csrf_required: false
      };
    }

    try {
      const csrf = await createCsrfToken(user);
      return {
        ok: true,
        csrf_token: csrf.token,
        expires_at: csrf.expires_at
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create CSRF token");
      return reply.code(503).send({
        ok: false,
        error: { code: "database_unavailable", message: "Database is not available." }
      });
    }
  });

  app.get("/v1/me/player", async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    try {
      const { player, linkState } = await findLinkedPlayerWithRepair(user);

      if (!player) {
        const message =
          linkState.reason === "steam_identity_linked_but_player_missing"
            ? "Steam is linked, but no player stats record exists yet."
            : linkState.reason === "discord_identity_linked_but_player_missing"
              ? "Discord is linked, but no player stats record exists yet."
              : "Link Steam or ask an admin to link your player record.";

        return {
          ok: true,
          linked_player: null,
          link_state: linkState,
          message
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
          COALESCE(SUM(ops.deaths), 0)::int AS deaths,
          COALESCE(SUM(ops.soft_vehicle_kills), 0)::int AS soft_vehicle_kills,
          COALESCE(SUM(ops.armor_kills), 0)::int AS armor_kills,
          COALESCE(SUM(ops.air_kills), 0)::int AS air_kills
        FROM operation_players op
        LEFT JOIN operation_player_stats ops
          ON ops.operation_id = op.operation_id
          AND ops.player_uid = op.player_uid
        WHERE op.player_uid = $1
        `,
        [player.player_uid]
      );

      const summary = summaryResult.rows[0] ?? {
        operation_count: 0,
        present_at_start_count: 0,
        present_at_end_count: 0,
        infantry_kills: 0,
        vehicle_kills: 0,
        player_kills: 0,
        ai_kills: 0,
        friendly_kills: 0,
        deaths: 0,
        soft_vehicle_kills: 0,
        armor_kills: 0,
        air_kills: 0
      };
      const membershipRows = await getDrizzleDb()
        .select({
          unit_id: units.id,
          unit_key: units.unitKey,
          name: units.name,
          display_name: units.displayName,
          callsign: units.callsign,
          rank: sql<string | null>`COALESCE(${unitRanks.name}, ${unitPlayers.rank})`,
          roster_name: unitPlayers.rosterName,
          roster_status: unitPlayers.rosterStatus
        })
        .from(unitPlayers)
        .innerJoin(units, eq(units.id, unitPlayers.unitId))
        .leftJoin(unitRanks, eq(unitRanks.id, unitPlayers.rankId))
        .where(
          and(
            eq(unitPlayers.playerUid, player.player_uid),
            eq(unitPlayers.isActive, true),
            ne(unitPlayers.rosterStatus, "inactive"),
            eq(units.isActive, true),
            sql`${units.deletedAt} IS NULL`
          )
        )
        .orderBy(units.sortOrder, units.name);

      return {
        ok: true,
        link_state: linkState,
        linked_player: {
          display_name: player.roster_name ?? player.last_name,
          rank: membershipRows[0]?.rank ?? player.rank,
          first_seen_at: player.first_seen_at,
          last_seen_at: player.last_seen_at
        },
        battalion_memberships: membershipRows.map((membership: SelfUnitMembershipRow) => ({
          unit_id: membership.unit_id,
          unit_key: membership.unit_key,
          name: membership.display_name ?? membership.name,
          callsign: membership.callsign,
          rank: membership.rank,
          roster_name: membership.roster_name,
          roster_status: membership.roster_status
        })),
        summary,
        scoreboard_totals: {
          infantry_kills: summary.infantry_kills,
          soft_vehicle_kills: summary.soft_vehicle_kills,
          armor_kills: summary.armor_kills,
          air_kills: summary.air_kills,
          deaths: summary.deaths
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

      const rows = await getDrizzleDb()
        .select({
          operation_id: operations.id,
          status: operations.status,
          mission_name: operations.missionName,
          world_name: operations.worldName,
          started_at: operations.startedAt,
          ended_at: operations.endedAt,
          present_at_start: operationPlayers.presentAtStart,
          present_at_end: operationPlayers.presentAtEnd
        })
        .from(operationPlayers)
        .innerJoin(operations, eq(operations.id, operationPlayers.operationId))
        .where(eq(operationPlayers.playerUid, player.player_uid))
        .orderBy(desc(operations.startedAt))
        .limit(5);

      return {
        ok: true,
        linked_player: {
          display_name: player.roster_name ?? player.last_name,
          rank: player.rank
        },
        operations: rows as SelfOperationRow[]
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

      const [operation] = (await getDrizzleDb()
        .select({
          operation_id: operations.id,
          status: operations.status,
          mission_name: operations.missionName,
          world_name: operations.worldName,
          started_at: operations.startedAt,
          ended_at: operations.endedAt,
          present_at_start: operationPlayers.presentAtStart,
          present_at_end: operationPlayers.presentAtEnd
        })
        .from(operationPlayers)
        .innerJoin(operations, eq(operations.id, operationPlayers.operationId))
        .where(and(eq(operationPlayers.playerUid, player.player_uid), eq(operationPlayers.operationId, parsedParams.data.operation_id)))
        .limit(1)) as SelfOperationRow[];

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

      const attended = await getDrizzleDb()
        .select({ player_uid: operationPlayers.playerUid })
        .from(operationPlayers)
        .where(and(eq(operationPlayers.operationId, parsedQuery.data.operation_id), eq(operationPlayers.playerUid, player.player_uid)))
        .limit(1);

      if (!attended[0]) {
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

  app.get("/auth/steam/start", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
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

    const state = await insertOAuthState("steam", getSafeReturnTo(parsedQuery.data.return_to ?? parsedQuery.data.redirect_after), user.id);
    return reply.redirect(steamOpenIdUrl(state));
  });

  app.post("/auth/steam/link-ticket", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    const parsedBody = steamLinkTicketBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    if (!config.steamReturnUrl || !config.steamRealm) {
      return sendAuthUnavailable(reply, "Steam OpenID is not configured.");
    }

    try {
      const returnTo = getSafeReturnTo(parsedBody.data.return_to ?? parsedBody.data.redirect_after);
      const ticket = await createSteamLinkTicket(user.id, returnTo, request);

      return {
        ok: true,
        steam_start_url: steamStartTicketUrl(ticket.ticket),
        expires_at: ticket.expires_at
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create Steam link ticket");
      return reply.code(503).send({
        ok: false,
        error: { code: "database_unavailable", message: "Database is not available." }
      });
    }
  });

  app.get("/auth/steam/start-ticket", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsedQuery = steamStartTicketQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    if (!config.steamReturnUrl || !config.steamRealm) {
      return sendAuthUnavailable(reply, "Steam OpenID is not configured.");
    }

    try {
      const state = await withDbTransaction(async (tx) => {
        const ticket = await consumeSteamLinkTicket(tx, parsedQuery.data.ticket);

        if (!ticket) {
          return null;
        }

        return insertOAuthStateWithClient(tx, "steam", ticket.return_to, ticket.user_id);
      });

      if (!state) {
        return reply.code(400).send({
          ok: false,
          error: { code: "invalid_link_ticket", message: "Steam link ticket is invalid, expired, or already used." }
        });
      }

      return reply.redirect(steamOpenIdUrl(state));
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to start Steam ticket link");
      return reply.code(503).send({
        ok: false,
        error: { code: "database_unavailable", message: "Database is not available." }
      });
    }
  });

  app.get("/auth/steam/callback", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
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
      return reply.redirect(steamLinkedReturnTo(state.redirect_after));
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

  app.post("/auth/test/login", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
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

  app.post("/auth/test/jwt-handoff", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (config.nodeEnv === "production" && !config.enableTestAuth) {
      return reply.code(404).send({ ok: false, error: { code: "not_found", message: "Route not found." } });
    }

    if (!isJwtAuthEnabled()) {
      return sendJwtAuthDisabled(reply);
    }

    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    const parsedBody = testJwtHandoffBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const returnTo = getSafeReturnTo(parsedBody.data.return_to);
    const handoff = await createJwtHandoffCode(user.id, returnTo, request);

    return {
      ok: true,
      handoff_code: handoff.code,
      expires_at: handoff.expires_at,
      return_to: returnTo
    };
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
