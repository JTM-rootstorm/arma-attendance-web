import type { ParsedEnv } from "./envSchema.js";

export function validateApplicationEnv(env: ParsedEnv): void {
  if (env.NODE_ENV === "production") {
    if (env.API_TOKEN === "change-this-token" || env.API_TOKEN.length < 24) {
      throw new Error("Invalid application configuration: API_TOKEN must be replaced with a strong production token.");
    }

    if (!env.SESSION_SECRET || env.SESSION_SECRET === "change-this-session-secret" || env.SESSION_SECRET.length < 24) {
      throw new Error("Invalid application configuration: SESSION_SECRET must be replaced with a strong production secret.");
    }

    if (
      env.JWT_AUTH_ENABLED &&
      (!env.JWT_SECRET || env.JWT_SECRET === "change-this-jwt-secret" || env.JWT_SECRET.length < 32)
    ) {
      throw new Error("Invalid application configuration: JWT_SECRET must be replaced with a strong production secret.");
    }
  }

  if (env.SESSION_SAME_SITE === "None" && env.SESSION_SECURE !== true) {
    throw new Error("Invalid application configuration: SESSION_SAME_SITE=None requires SESSION_SECURE=true.");
  }
}
