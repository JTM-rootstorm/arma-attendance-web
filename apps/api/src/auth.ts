import { createHash, randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { config } from "./config.js";
import { isLikelyJwt, verifyAccessJwt } from "./auth/jwt.js";
import { machineTokenKindSets } from "./auth/machineTokenKinds.js";
import { getDrizzleDb } from "./db/drizzle.js";
import { appUsers, userIdentities, userRoles, userSessions } from "./db/schema/auth.js";
import { machineTokens } from "./db/schema/machineTokens.js";

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
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);
  const db = getDrizzleDb();
  const [row] = await db
    .insert(userSessions)
    .values({
      userId,
      sessionTokenHash: tokenHash,
      expiresAt,
      userAgent: request.headers["user-agent"] ?? null,
      ipAddress: request.ip
    })
    .returning({
      id: userSessions.id,
      expires_at: userSessions.expiresAt
    });

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

  const db = getDrizzleDb();
  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(userSessions.sessionTokenHash, hashSessionToken(token)), isNull(userSessions.revokedAt)));
}

export async function loadCurrentUserById(userId: string, sessionId = "jwt"): Promise<CurrentUser | null> {
  const db = getDrizzleDb();
  const [row] = await db
    .select({
      user_id: appUsers.id,
      display_name: appUsers.displayName,
      avatar_url: appUsers.avatarUrl,
      disabled_at: appUsers.disabledAt
    })
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1);

  if (!row || row.disabled_at) {
    return null;
  }

  const [roleRows, identityRows] = await Promise.all([
    db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, row.user_id)),
    db
      .select({
        provider: userIdentities.provider,
        provider_user_id: userIdentities.providerUserId,
        display_name: userIdentities.displayName,
        avatar_url: userIdentities.avatarUrl
      })
      .from(userIdentities)
      .where(eq(userIdentities.userId, row.user_id))
  ]);

  return {
    id: row.user_id,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    disabled_at: row.disabled_at,
    roles: Array.from(new Set(roleRows.map((roleRow) => roleRow.role).filter((role): role is AppRole => appRoles.includes(role as AppRole)))),
    identities: identityRows
      .filter((identity): identity is typeof identity & { provider: IdentityProvider } =>
        identity.provider === "discord" || identity.provider === "steam"
      )
      .map((identity) => ({
        provider: identity.provider,
        provider_user_id: identity.provider_user_id,
        display_name: identity.display_name,
        avatar_url: identity.avatar_url
      })),
    session_id: sessionId
  };
}

export async function getCurrentUserFromCookie(request: FastifyRequest): Promise<CurrentUser | null> {
  const token = getSessionToken(request);

  if (!token) {
    return null;
  }

  const db = getDrizzleDb();
  const [row] = (await db
    .select({
      session_id: userSessions.id,
      user_id: appUsers.id,
      display_name: appUsers.displayName,
      avatar_url: appUsers.avatarUrl,
      disabled_at: appUsers.disabledAt
    })
    .from(userSessions)
    .innerJoin(appUsers, eq(appUsers.id, userSessions.userId))
    .where(
      and(
        eq(userSessions.sessionTokenHash, hashSessionToken(token)),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, sql<Date>`now()`)
      )
    )
    .limit(1)) as SessionUserRow[];

  if (!row || row.disabled_at) {
    return null;
  }

  await db.update(userSessions).set({ lastSeenAt: sql`now()` }).where(eq(userSessions.id, row.session_id));
  return loadCurrentUserById(row.user_id, row.session_id);
}

export async function getCurrentUserFromJwt(request: FastifyRequest): Promise<CurrentUser | null> {
  const token = getBearerToken(request);

  if (!token || !isLikelyJwt(token)) {
    return null;
  }

  const verified = await verifyAccessJwt(token);

  if (!verified) {
    return null;
  }

  return loadCurrentUserById(verified.user_id);
}

export async function getCurrentUser(request: FastifyRequest): Promise<CurrentUser | null> {
  return (await getCurrentUserFromJwt(request)) ?? getCurrentUserFromCookie(request);
}

async function findActiveDbMachineToken(request: FastifyRequest, kinds: readonly MachineTokenKind[]): Promise<MachineTokenKind | null> {
  const token = getBearerToken(request);

  if (!token || !config.databaseUrl) {
    return null;
  }

  const tokenHash = hashMachineToken(token);
  let row: { id: string; token_kind: MachineTokenKind } | undefined;

  try {
    const db = getDrizzleDb();
    const rows = await db
      .select({ id: machineTokens.id, token_kind: machineTokens.tokenKind })
      .from(machineTokens)
      .where(
        and(
          eq(machineTokens.tokenHash, tokenHash),
          inArray(machineTokens.tokenKind, kinds),
          eq(machineTokens.isActive, true),
          isNull(machineTokens.revokedAt)
        )
      )
      .limit(1);
    row = rows[0] as { id: string; token_kind: MachineTokenKind } | undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "42P01") {
      return null;
    }

    throw error;
  }

  if (!row) {
    return null;
  }

  await getDrizzleDb().update(machineTokens).set({ lastUsedAt: sql`now()` }).where(eq(machineTokens.id, row.id));
  return row.token_kind;
}

export async function getAcceptedMachineTokenKind(request: FastifyRequest, kinds: readonly MachineTokenKind[]): Promise<MachineTokenKind | null> {
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
  if (!(await getAcceptedMachineTokenKind(request, machineTokenKindSets.ingest))) {
    return unauthorized(reply);
  }
}

export async function isMachineTokenRequest(request: FastifyRequest): Promise<boolean> {
  return Boolean(await getAcceptedMachineTokenKind(request, machineTokenKindSets.ingest));
}

export async function isAdminOrBotTokenRequest(request: FastifyRequest): Promise<boolean> {
  return Boolean(await getAcceptedMachineTokenKind(request, machineTokenKindSets.adminOrBotOrIngest));
}

export async function isBase44TokenRequest(request: FastifyRequest): Promise<boolean> {
  return Boolean(await getAcceptedMachineTokenKind(request, machineTokenKindSets.base44));
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
