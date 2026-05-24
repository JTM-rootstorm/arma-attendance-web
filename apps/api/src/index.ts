import Fastify from "fastify";
import cors from "@fastify/cors";

import { config, loadedEnvFiles } from "./config.js";
import { closeDbPool } from "./db/pool.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDataQualityRoutes } from "./routes/dataQuality.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerDiscordRoutes } from "./routes/discord.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerHealthDbRoutes } from "./routes/healthDb.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIngestRequestRoutes } from "./routes/ingestRequests.js";
import { registerLeaderboardRoutes } from "./routes/leaderboards.js";
import { registerOperationRoutes } from "./routes/operations.js";
import { registerOwnerRoutes } from "./routes/owner.js";
import { registerPlayerRoutes } from "./routes/players.js";
import { registerSummaryRoutes } from "./routes/summaries.js";
import { registerUnitRoutes } from "./routes/units.js";
import { registerWebRoutes } from "./routes/web.js";

const app = Fastify({
  logger: {
    level: config.logLevel
  }
});

app.log.info(
  {
    nodeEnv: config.nodeEnv,
    envFilesLoaded: loadedEnvFiles.filter((envFile) => envFile.loaded).length,
    apiTokenPresent: Boolean(config.apiToken),
    botApiTokenPresent: Boolean(config.botApiToken),
    discordOAuthConfigured: Boolean(config.discordClientId && config.discordClientSecret && config.discordRedirectUri),
    steamOpenIdConfigured: Boolean(config.steamReturnUrl && config.steamRealm),
    sessionSecure: config.sessionSecure,
    sessionSameSite: config.sessionSameSite,
    corsAllowedOrigins: config.corsAllowedOrigins,
    corsAllowCredentials: config.corsAllowCredentials,
    initialAdminFallbackActive: config.initialAdminDiscordIds.length > 0,
    testAuthEnabled: config.enableTestAuth,
    databaseUrlPresent: Boolean(config.databaseUrl)
  },
  "configuration loaded"
);

function getStatusCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return 500;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode >= 400 ? statusCode : 500;
}

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "Request failed");

  const statusCode = getStatusCode(error);
  const code = statusCode === 400 ? "invalid_request" : "internal_server_error";
  const message = statusCode === 400 ? "Request could not be processed." : "Internal server error.";

  return reply.code(statusCode).send({
    ok: false,
    error: {
      code,
      message
    }
  });
});

app.setNotFoundHandler((_request, reply) =>
  reply.code(404).send({
    ok: false,
    error: {
      code: "not_found",
      message: "Route not found."
    }
  })
);

app.addHook("onClose", async () => {
  await closeDbPool();
});

const allowedCorsOrigins = new Set(config.corsAllowedOrigins);

await app.register(cors, {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    callback(null, allowedCorsOrigins.has(origin));
  },
  credentials: config.corsAllowCredentials,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  exposedHeaders: ["Content-Disposition"],
  maxAge: 600
});

await registerHealthRoutes(app);
await registerHealthDbRoutes(app);
await registerAuthRoutes(app);
await registerAdminRoutes(app);
await registerDebugRoutes(app);
await registerSummaryRoutes(app);
await registerExportRoutes(app);
await registerDataQualityRoutes(app);
await registerDiscordRoutes(app);
await registerOperationRoutes(app);
await registerOwnerRoutes(app);
await registerIngestRequestRoutes(app);
await registerPlayerRoutes(app);
await registerUnitRoutes(app);
await registerLeaderboardRoutes(app);
await registerWebRoutes(app);

try {
  await app.listen({
    host: config.host,
    port: config.port
  });

  app.log.info(
    {
      service: config.appName,
      version: config.appVersion,
      host: config.host,
      port: config.port,
      environment: config.nodeEnv
    },
    "API service started"
  );
} catch (error) {
  app.log.error({ err: error }, "API service failed to start");
  process.exit(1);
}
