import { z } from "zod";

import { loadEnv } from "./config/loadEnv.js";

export const loadedEnvFiles = loadEnv();

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  APP_NAME: z.string().min(1),
  APP_VERSION: z.string().min(1),
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  PUBLIC_BASE_URL: z.string().url(),
  API_TOKEN: z.string().min(1),
  BOT_API_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_REDIRECT_URI: z.string().url().optional(),
  STEAM_RETURN_URL: z.string().url().optional(),
  STEAM_REALM: z.string().url().optional(),
  SESSION_COOKIE_NAME: z.string().min(1).default("arma_attendance_session"),
  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
  SESSION_SECURE: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .or(z.boolean())
    .default(true),
  SESSION_SAME_SITE: z.enum(["Lax", "Strict", "None"]).default("Lax"),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  CORS_ALLOW_CREDENTIALS: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .or(z.boolean())
    .default(true),
  INITIAL_ADMIN_DISCORD_IDS: z.string().optional(),
  ENABLE_TEST_AUTH: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .or(z.boolean())
    .default(false),
  LOG_LEVEL: logLevelSchema,
  DATABASE_URL: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid application configuration: ${issues}`);
}

const env = parsed.data;

if (env.NODE_ENV === "production") {
  if (env.API_TOKEN === "change-this-token" || env.API_TOKEN.length < 24) {
    throw new Error("Invalid application configuration: API_TOKEN must be replaced with a strong production token.");
  }

  if (!env.SESSION_SECRET || env.SESSION_SECRET === "change-this-session-secret" || env.SESSION_SECRET.length < 24) {
    throw new Error("Invalid application configuration: SESSION_SECRET must be replaced with a strong production secret.");
  }
}

if (env.SESSION_SAME_SITE === "None" && env.SESSION_SECURE !== true) {
  throw new Error("Invalid application configuration: SESSION_SAME_SITE=None requires SESSION_SECURE=true.");
}

export const config = {
  nodeEnv: env.NODE_ENV,
  appName: env.APP_NAME,
  appVersion: env.APP_VERSION,
  host: env.HOST,
  port: env.PORT,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  apiToken: env.API_TOKEN,
  botApiToken: env.BOT_API_TOKEN && env.BOT_API_TOKEN.length > 0 ? env.BOT_API_TOKEN : undefined,
  discordClientId: env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_ID.length > 0 ? env.DISCORD_CLIENT_ID : undefined,
  discordClientSecret:
    env.DISCORD_CLIENT_SECRET && env.DISCORD_CLIENT_SECRET.length > 0 ? env.DISCORD_CLIENT_SECRET : undefined,
  discordRedirectUri: env.DISCORD_REDIRECT_URI,
  steamReturnUrl: env.STEAM_RETURN_URL,
  steamRealm: env.STEAM_REALM,
  sessionCookieName: env.SESSION_COOKIE_NAME,
  sessionSecret: env.SESSION_SECRET && env.SESSION_SECRET.length > 0 ? env.SESSION_SECRET : undefined,
  sessionTtlHours: env.SESSION_TTL_HOURS,
  sessionSecure: env.SESSION_SECURE,
  sessionSameSite: env.SESSION_SAME_SITE,
  corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
  corsAllowCredentials: env.CORS_ALLOW_CREDENTIALS,
  initialAdminDiscordIds: (env.INITIAL_ADMIN_DISCORD_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
  enableTestAuth: env.ENABLE_TEST_AUTH,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL
} as const;
