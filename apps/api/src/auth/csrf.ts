import { createHash, randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { getAcceptedMachineTokenKind, getCurrentUser, type CurrentUser } from "../auth.js";
import { config } from "../config.js";
import { queryDb } from "../db/pool.js";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const csrfExemptPaths = new Set(["/auth/jwt/exchange", "/auth/jwt/refresh", "/auth/jwt/logout"]);

type CsrfTokenRow = {
  expires_at: Date;
};

export function hashCsrfToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createCsrfToken(user: CurrentUser): Promise<{ token: string; expires_at: Date }> {
  const token = generateCsrfToken();
  const result = await queryDb<CsrfTokenRow>(
    `
    INSERT INTO session_csrf_tokens (session_id, token_hash, expires_at)
    VALUES ($1, $2, now() + ($3::int * interval '1 minute'))
    RETURNING expires_at
    `,
    [user.session_id, hashCsrfToken(token), config.csrfTokenTtlMinutes]
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("CSRF token insert returned no row.");
  }

  return { token, expires_at: row.expires_at };
}

function csrfFailed(reply: FastifyReply, message = "CSRF validation failed.") {
  return reply.code(403).send({
    ok: false,
    error: {
      code: "csrf_failed",
      message
    }
  });
}

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();

  try {
    origins.add(new URL(config.publicBaseUrl).origin);
  } catch {
    // PUBLIC_BASE_URL is validated at config load.
  }

  for (const value of [...config.corsAllowedOrigins, ...config.oauthAllowedReturnOrigins]) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      origins.add(value);
    }
  }

  return origins;
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function hasValidCsrfToken(user: CurrentUser, token: string): Promise<boolean> {
  const result = await queryDb<{ id: string }>(
    `
    SELECT id
    FROM session_csrf_tokens
    WHERE session_id = $1
      AND token_hash = $2
      AND expires_at > now()
      AND used_at IS NULL
    LIMIT 1
    `,
    [user.session_id, hashCsrfToken(token)]
  );

  return Boolean(result.rows[0]);
}

export async function requireCsrfForUnsafeSessionRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  if (!config.csrfEnabled || !unsafeMethods.has(request.method.toUpperCase())) {
    return true;
  }

  if (csrfExemptPaths.has(request.url.split("?")[0] ?? request.url)) {
    return true;
  }

  if (await getAcceptedMachineTokenKind(request, ["api", "bot", "arma_server", "base44_integration"])) {
    return true;
  }

  const user = await getCurrentUser(request);

  if (!user) {
    return true;
  }

  const origin = getSingleHeader(request.headers.origin);
  if (!origin || !getAllowedOrigins().has(origin)) {
    csrfFailed(reply, "Unsafe session requests require an allowed Origin header.");
    return false;
  }

  const token = getSingleHeader(request.headers["x-csrf-token"]);
  if (!token || !(await hasValidCsrfToken(user, token))) {
    csrfFailed(reply);
    return false;
  }

  return true;
}
