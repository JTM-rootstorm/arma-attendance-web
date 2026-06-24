import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const booleanEnv = (defaultValue: boolean) =>
  z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .or(z.boolean())
    .default(defaultValue);

export const envSchema = z.object({
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
  DISCORD_AUTH_ENABLED: booleanEnv(true),
  DISCORD_AUTH_REQUIRE_GUILD: booleanEnv(false),
  DISCORD_AUTH_CONFIG_PATH: z.string().optional(),
  DISCORD_AUTH_DEFAULT_FALLBACK_GUILD_IDS: z.string().default("1478100812818550845"),
  DISCORD_AUTH_ALLOW_FALLBACK_GUILD_IDS: booleanEnv(false),
  DISCORD_AUTH_REQUIRE_CONFIG_FILE: booleanEnv(true),
  DISCORD_AUTH_RECONCILE_ON_LOGIN: booleanEnv(true),
  DISCORD_AUTH_RECONCILE_STALE_AFTER_MINUTES: z.coerce.number().int().min(1).max(60 * 24 * 30).default(240),
  DISCORD_AUTH_ALLOW_OAUTH_REFRESH_STORAGE: booleanEnv(false),
  STEAM_RETURN_URL: z.string().url().optional(),
  STEAM_REALM: z.string().url().optional(),
  SESSION_COOKIE_NAME: z.string().min(1).default("arma_attendance_session"),
  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
  SESSION_SECURE: booleanEnv(true),
  SESSION_SAME_SITE: z.enum(["Lax", "Strict", "None"]).default("Lax"),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  CORS_ALLOW_CREDENTIALS: booleanEnv(true),
  OAUTH_ALLOWED_RETURN_ORIGINS: z.string().optional(),
  JWT_AUTH_ENABLED: booleanEnv(false),
  JWT_ISSUER: z.string().url().optional(),
  JWT_AUDIENCE: z.string().min(1).default("arma-attendance-web"),
  JWT_SECRET: z.string().optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(60 * 60).default(900),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  JWT_HANDOFF_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
  CSRF_ENABLED: booleanEnv(true),
  CSRF_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(120),
  SQUAD_ASSET_ROOT: z.string().min(1).default("/var/lib/arma-attendance/squad-assets"),
  SQUAD_XML_DEFAULT_PICTURE: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\.paa$/)
    .default("logo.paa"),
  INITIAL_ADMIN_DISCORD_IDS: z.string().optional(),
  ENABLE_TEST_AUTH: booleanEnv(false),
  LOG_LEVEL: logLevelSchema,
  DATABASE_URL: z.string().optional(),
  OPERATION_INGEST_QUEUE_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OPERATION_INGEST_QUEUE_SYNC_WAIT_MS: z.coerce.number().int().min(0).max(30_000).default(5000),
  OPERATION_INGEST_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OPERATION_INGEST_QUEUE_RETRY_DELAY_SECONDS: z.coerce.number().int().min(1).max(60 * 60).default(30)
});

export type ParsedEnv = z.infer<typeof envSchema>;
