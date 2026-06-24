import type { ParsedEnv } from "./envSchema.js";

function optionalString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function buildRuntimeConfig(env: ParsedEnv) {
  return {
    nodeEnv: env.NODE_ENV,
    appName: env.APP_NAME,
    appVersion: env.APP_VERSION,
    host: env.HOST,
    port: env.PORT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    apiToken: env.API_TOKEN,
    botApiToken: optionalString(env.BOT_API_TOKEN),
    discordClientId: optionalString(env.DISCORD_CLIENT_ID),
    discordClientSecret: optionalString(env.DISCORD_CLIENT_SECRET),
    discordRedirectUri: env.DISCORD_REDIRECT_URI,
    discordAuthEnabled: env.DISCORD_AUTH_ENABLED,
    discordAuthRequireGuild: env.DISCORD_AUTH_REQUIRE_GUILD,
    discordAuthConfigPath: optionalString(env.DISCORD_AUTH_CONFIG_PATH),
    discordAuthDefaultFallbackGuildIds: csv(env.DISCORD_AUTH_DEFAULT_FALLBACK_GUILD_IDS),
    discordAuthAllowFallbackGuildIds: env.DISCORD_AUTH_ALLOW_FALLBACK_GUILD_IDS,
    discordAuthRequireConfigFile: env.DISCORD_AUTH_REQUIRE_CONFIG_FILE,
    discordAuthReconcileOnLogin: env.DISCORD_AUTH_RECONCILE_ON_LOGIN,
    discordAuthReconcileStaleAfterMinutes: env.DISCORD_AUTH_RECONCILE_STALE_AFTER_MINUTES,
    discordAuthAllowOAuthRefreshStorage: env.DISCORD_AUTH_ALLOW_OAUTH_REFRESH_STORAGE,
    steamReturnUrl: env.STEAM_RETURN_URL,
    steamRealm: env.STEAM_REALM,
    sessionCookieName: env.SESSION_COOKIE_NAME,
    sessionSecret: optionalString(env.SESSION_SECRET),
    sessionTtlHours: env.SESSION_TTL_HOURS,
    sessionSecure: env.SESSION_SECURE,
    sessionSameSite: env.SESSION_SAME_SITE,
    corsAllowedOrigins: csv(env.CORS_ALLOWED_ORIGINS),
    corsAllowCredentials: env.CORS_ALLOW_CREDENTIALS,
    oauthAllowedReturnOrigins: csv(env.OAUTH_ALLOWED_RETURN_ORIGINS),
    jwtAuthEnabled: env.JWT_AUTH_ENABLED,
    jwtIssuer: env.JWT_ISSUER ?? env.PUBLIC_BASE_URL,
    jwtAudience: env.JWT_AUDIENCE,
    jwtSecret: optionalString(env.JWT_SECRET),
    jwtAccessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    jwtRefreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
    jwtHandoffTtlSeconds: env.JWT_HANDOFF_TTL_SECONDS,
    csrfEnabled: env.CSRF_ENABLED,
    csrfTokenTtlMinutes: env.CSRF_TOKEN_TTL_MINUTES,
    squadAssetRoot: env.SQUAD_ASSET_ROOT,
    squadXmlDefaultPicture: env.SQUAD_XML_DEFAULT_PICTURE,
    initialAdminDiscordIds: csv(env.INITIAL_ADMIN_DISCORD_IDS),
    enableTestAuth: env.ENABLE_TEST_AUTH,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    operationIngestQueuePollMs: env.OPERATION_INGEST_QUEUE_POLL_MS,
    operationIngestQueueSyncWaitMs: env.OPERATION_INGEST_QUEUE_SYNC_WAIT_MS,
    operationIngestQueueMaxAttempts: env.OPERATION_INGEST_QUEUE_MAX_ATTEMPTS,
    operationIngestQueueRetryDelaySeconds: env.OPERATION_INGEST_QUEUE_RETRY_DELAY_SECONDS
  } as const;
}
