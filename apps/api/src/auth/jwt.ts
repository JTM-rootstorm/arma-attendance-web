import { createHash, randomBytes } from "node:crypto";

import type { FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";

import { config } from "../config.js";
import { queryDb } from "../db/pool.js";
import { withDbTransaction } from "../db/transactions.js";

type HandoffCodeRow = {
  user_id: string;
  return_to: string;
};

type RefreshTokenRow = {
  id: string;
  user_id: string;
  family_id: string;
  rotated_at: Date | null;
  revoked_at: Date | null;
};

export type JwtHandoffCode = {
  code: string;
  expires_at: Date;
};

export type ConsumedJwtHandoffCode = {
  user_id: string;
  return_to: string;
};

export type IssuedRefreshToken = {
  token: string;
  token_id: string;
  family_id: string;
  expires_at: Date;
};

export type RotatedRefreshToken = {
  user_id: string;
  refresh_token: IssuedRefreshToken;
};

export type VerifiedAccessJwt = {
  user_id: string;
};

function ensureJwtEnabled() {
  if (!config.jwtAuthEnabled) {
    throw new Error("jwt_auth_disabled");
  }

  if (!config.jwtSecret) {
    throw new Error("jwt_secret_missing");
  }
}

function jwtSecretKey(): Uint8Array {
  ensureJwtEnabled();
  return new TextEncoder().encode(config.jwtSecret);
}

function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requestUserAgent(request: FastifyRequest): string | null {
  const userAgent = request.headers["user-agent"];
  return Array.isArray(userAgent) ? (userAgent[0] ?? null) : (userAgent ?? null);
}

export function isJwtAuthEnabled(): boolean {
  return config.jwtAuthEnabled && Boolean(config.jwtSecret);
}

export function isLikelyJwt(token: string): boolean {
  return token.split(".").length === 3;
}

export function generateJwtHandoffCode(): string {
  return randomBytes(32).toString("base64url");
}

export function generateRefreshToken(): string {
  return `aat_refresh_${randomBytes(32).toString("base64url")}`;
}

export async function createJwtHandoffCode(
  userId: string,
  returnTo: string,
  request: FastifyRequest
): Promise<JwtHandoffCode> {
  ensureJwtEnabled();

  const code = generateJwtHandoffCode();
  const result = await queryDb<{ expires_at: Date }>(
    `
    INSERT INTO auth_jwt_handoff_codes (code_hash, user_id, return_to, expires_at, ip_address, user_agent)
    VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'), $5, $6)
    RETURNING expires_at
    `,
    [hashOpaqueToken(code), userId, returnTo, config.jwtHandoffTtlSeconds, request.ip, requestUserAgent(request)]
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("JWT handoff insert returned no row.");
  }

  return {
    code,
    expires_at: row.expires_at
  };
}

export async function consumeJwtHandoffCode(code: string): Promise<ConsumedJwtHandoffCode | null> {
  ensureJwtEnabled();

  return withDbTransaction(async (tx) => {
    const result = await tx.query<HandoffCodeRow>(
      `
      UPDATE auth_jwt_handoff_codes
      SET consumed_at = now()
      WHERE code_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING user_id, return_to
      `,
      [hashOpaqueToken(code)]
    );

    return result.rows[0] ?? null;
  });
}

export async function issueAccessJwt(userId: string): Promise<string> {
  return new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.jwtAccessTtlSeconds}s`)
    .sign(jwtSecretKey());
}

export async function verifyAccessJwt(token: string): Promise<VerifiedAccessJwt | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecretKey(), {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience
    });

    if (payload.typ !== "access" || typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }

    return { user_id: payload.sub };
  } catch {
    return null;
  }
}

export async function issueRefreshToken(
  userId: string,
  request: FastifyRequest,
  familyId?: string
): Promise<IssuedRefreshToken> {
  ensureJwtEnabled();

  const token = generateRefreshToken();
  const result = await queryDb<{ id: string; family_id: string; expires_at: Date }>(
    `
    INSERT INTO auth_refresh_tokens (user_id, token_hash, family_id, expires_at, ip_address, user_agent)
    VALUES ($1, $2, COALESCE($3::uuid, gen_random_uuid()), now() + ($4::int * interval '1 day'), $5, $6)
    RETURNING id, family_id, expires_at
    `,
    [userId, hashOpaqueToken(token), familyId ?? null, config.jwtRefreshTtlDays, request.ip, requestUserAgent(request)]
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("Refresh token insert returned no row.");
  }

  return {
    token,
    token_id: row.id,
    family_id: row.family_id,
    expires_at: row.expires_at
  };
}

export async function rotateRefreshToken(refreshToken: string, request: FastifyRequest): Promise<RotatedRefreshToken | null> {
  ensureJwtEnabled();

  return withDbTransaction(async (tx) => {
    const result = await tx.query<RefreshTokenRow>(
      `
      SELECT id, user_id, family_id, rotated_at, revoked_at
      FROM auth_refresh_tokens
      WHERE token_hash = $1
        AND expires_at > now()
      FOR UPDATE
      `,
      [hashOpaqueToken(refreshToken)]
    );
    const row = result.rows[0];

    if (!row || row.revoked_at) {
      return null;
    }

    if (row.rotated_at) {
      await tx.query("UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1", [
        row.family_id
      ]);
      return null;
    }

    const token = generateRefreshToken();
    const nextResult = await tx.query<{ id: string; family_id: string; expires_at: Date }>(
      `
      INSERT INTO auth_refresh_tokens (user_id, token_hash, family_id, expires_at, ip_address, user_agent)
      VALUES ($1, $2, $3, now() + ($4::int * interval '1 day'), $5, $6)
      RETURNING id, family_id, expires_at
      `,
      [
        row.user_id,
        hashOpaqueToken(token),
        row.family_id,
        config.jwtRefreshTtlDays,
        request.ip,
        requestUserAgent(request)
      ]
    );
    const next = nextResult.rows[0];

    if (!next) {
      throw new Error("Refresh token rotation insert returned no row.");
    }

    await tx.query("UPDATE auth_refresh_tokens SET rotated_at = now(), replaced_by_token_id = $2 WHERE id = $1", [row.id, next.id]);

    return {
      user_id: row.user_id,
      refresh_token: {
        token,
        token_id: next.id,
        family_id: next.family_id,
        expires_at: next.expires_at
      }
    };
  });
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  ensureJwtEnabled();

  await queryDb(
    `
    UPDATE auth_refresh_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE token_hash = $1
    `,
    [hashOpaqueToken(refreshToken)]
  );
}
