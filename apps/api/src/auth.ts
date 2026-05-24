import { createHash, randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { config } from "./config.js";
import { queryDb } from "./db/pool.js";

export const appRoles = ["viewer", "officer", "admin", "tcw_admin", "owner"] as const;
export type AppRole = (typeof appRoles)[number];
export type IdentityProvider = "discord" | "steam";
export type MachineTokenKind = "api" | "bot" | "arma_server" | "base44_integration";

export type CurrentUser = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  disabled_at: Date | null;
  roles: AppRole[];
  identities: Array<{
    provider: IdentityProvider;
    provider_user_id: string;
    display_name: string | null;
    avatar_url: string | null;
  }>;
  session_id: string;
};

type SessionUserRow = {
  session_id: string;
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  disabled_at: Date | null;
  roles: AppRole[] | null;
  identities:
    | Array<{
        provider: IdentityProvider;
        provider_user_id: string;
        display_name: string | null;
        avatar_url: string | null;
      }>
    | null;
};

type SessionInsertRow = {
  id: string;
  expires_at: Date;
};

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    ok: false,
    error: {
      code: "unauthorized",
      message: "Missing or invalid bearer token."
    }
  });
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({
    ok: false,
    error: {
      code: "forbidden",
      message: "The authenticated user does not have permission for this action."
    }
  });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key.length > 0) {
      cookies[key] = decodeURIComponent(value);
    }
  }

  return cookies;
}

function roleRank(role: AppRole): number {
  return appRoles.indexOf(role);
}

function hasAllowedRole(user: CurrentUser, allowedRoles: AppRole[]): boolean {
  if (allowedRoles.length === 0) {
    return true;
  }

  const requiredRank = Math.min(...allowedRoles.map(roleRank));
  return user.roles.some((role) => roleRank(role) >= requiredRank);
}

function getSessionToken(request: FastifyRequest): string | null {
  return parseCookies(request.headers.cookie)[config.sessionCookieName] ?? null;
}

function getBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim();
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashMachineToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  const cookie = [
    `${config.sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${config.sessionSameSite}`,
    `Expires=${expiresAt.toUTCString()}`
  ];

  if (config.sessionSecure) {
    cookie.push("Secure");
  }

  reply.header("Set-Cookie", cookie.join("; "));
}

export function clearSessionCookie(reply: FastifyReply) {
  const cookie = [
    `${config.sessionCookieName}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${config.sessionSameSite}`,
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];

  if (config.sessionSecure) {
    cookie.push("Secure");
  }

  reply.header("Set-Cookie", cookie.join("; "));
}

export async function createUserSession(
  userId: string,
  request: FastifyRequest
): Promise<{ token: string; session_id: string; expires_at: Date }> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const result = await queryDb<SessionInsertRow>(
    `
    INSERT INTO user_sessions (
      user_id,
      session_token_hash,
      expires_at,
      user_agent,
      ip_address
    )
    VALUES ($1, $2, now() + ($3::int * interval '1 hour'), $4, $5)
    RETURNING id, expires_at
    `,
    [userId, tokenHash, config.sessionTtlHours, request.headers["user-agent"] ?? null, request.ip]
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("Session insert returned no row.");
  }

  return {
    token,
    session_id: row.id,
    expires_at: row.expires_at
  };
}

export async function revokeCurrentSession(request: FastifyRequest): Promise<void> {
  const token = getSessionToken(request);

  if (!token) {
    return;
  }

  await queryDb("UPDATE user_sessions SET revoked_at = now() WHERE session_token_hash = $1 AND revoked_at IS NULL", [
    hashSessionToken(token)
  ]);
}

export async function getCurrentUser(request: FastifyRequest): Promise<CurrentUser | null> {
  const token = getSessionToken(request);

  if (!token) {
    return null;
  }

  const result = await queryDb<SessionUserRow>(
    `
    SELECT
      us.id AS session_id,
      au.id AS user_id,
      au.display_name,
      au.avatar_url,
      au.disabled_at,
      COALESCE(
        array_agg(DISTINCT ur.role) FILTER (WHERE ur.role IS NOT NULL),
        ARRAY[]::text[]
      ) AS roles,
      COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
          'provider', ui.provider,
          'provider_user_id', ui.provider_user_id,
          'display_name', ui.display_name,
          'avatar_url', ui.avatar_url
        )) FILTER (WHERE ui.id IS NOT NULL),
        '[]'::jsonb
      ) AS identities
    FROM user_sessions us
    JOIN app_users au ON au.id = us.user_id
    LEFT JOIN user_roles ur ON ur.user_id = au.id
    LEFT JOIN user_identities ui ON ui.user_id = au.id
    WHERE us.session_token_hash = $1
      AND us.revoked_at IS NULL
      AND us.expires_at > now()
    GROUP BY us.id, au.id
    `,
    [hashSessionToken(token)]
  );
  const row = result.rows[0];

  if (!row || row.disabled_at) {
    return null;
  }

  await queryDb("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [row.session_id]);

  return {
    id: row.user_id,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    disabled_at: row.disabled_at,
    roles: (row.roles ?? []) as AppRole[],
    identities: row.identities ?? [],
    session_id: row.session_id
  };
}

async function findActiveDbMachineToken(request: FastifyRequest, kinds: MachineTokenKind[]): Promise<MachineTokenKind | null> {
  const token = getBearerToken(request);

  if (!token || !config.databaseUrl) {
    return null;
  }

  const tokenHash = hashMachineToken(token);
  let row: { id: string; token_kind: MachineTokenKind } | undefined;

  try {
    const result = await queryDb<{ id: string; token_kind: MachineTokenKind }>(
      `
      SELECT id, token_kind
      FROM machine_tokens
      WHERE token_hash = $1
        AND token_kind = ANY($2::text[])
        AND is_active = true
        AND revoked_at IS NULL
      LIMIT 1
      `,
      [tokenHash, kinds]
    );
    row = result.rows[0];
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "42P01") {
      return null;
    }

    throw error;
  }

  if (!row) {
    return null;
  }

  await queryDb("UPDATE machine_tokens SET last_used_at = now() WHERE id = $1", [row.id]);
  return row.token_kind;
}

export async function getAcceptedMachineTokenKind(request: FastifyRequest, kinds: MachineTokenKind[]): Promise<MachineTokenKind | null> {
  const token = getBearerToken(request);

  if (!token) {
    return null;
  }

  if (kinds.includes("api") && token === config.apiToken) {
    return "api";
  }

  if (kinds.includes("bot") && config.botApiToken && token === config.botApiToken) {
    return "bot";
  }

  return findActiveDbMachineToken(request, kinds);
}

export async function requireBearerToken(request: FastifyRequest, reply: FastifyReply) {
  if (!(await getAcceptedMachineTokenKind(request, ["api", "arma_server"]))) {
    return unauthorized(reply);
  }
}

export async function isMachineTokenRequest(request: FastifyRequest): Promise<boolean> {
  return Boolean(await getAcceptedMachineTokenKind(request, ["api", "arma_server"]));
}

export async function isAdminOrBotTokenRequest(request: FastifyRequest): Promise<boolean> {
  return Boolean(await getAcceptedMachineTokenKind(request, ["api", "bot", "arma_server"]));
}

export async function isBase44TokenRequest(request: FastifyRequest): Promise<boolean> {
  return Boolean(await getAcceptedMachineTokenKind(request, ["base44_integration"]));
}

export async function requireAdminOrBotToken(request: FastifyRequest, reply: FastifyReply) {
  if (!(await isAdminOrBotTokenRequest(request))) {
    return unauthorized(reply);
  }
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<CurrentUser | undefined> {
  const user = await getCurrentUser(request);

  if (!user) {
    unauthorized(reply);
    return undefined;
  }

  return user;
}

export function requireRole(allowedRoles: AppRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    if (!hasAllowedRole(user, allowedRoles)) {
      return forbidden(reply);
    }
  };
}

export function requireAnyAuth({
  allowMachineToken,
  roles = []
}: {
  allowMachineToken: boolean;
  roles?: AppRole[];
}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (allowMachineToken && (await isMachineTokenRequest(request))) {
      return;
    }

    const user = await requireUser(request, reply);

    if (!user) {
      return;
    }

    if (!hasAllowedRole(user, roles)) {
      return forbidden(reply);
    }
  };
}

export function hasRole(user: CurrentUser, roles: AppRole[]): boolean {
  return hasAllowedRole(user, roles);
}
