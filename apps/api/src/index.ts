import Fastify from "fastify";

import { config, loadedEnvFiles } from "./config.js";
import { closeDbPool } from "./db/pool.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerHealthDbRoutes } from "./routes/healthDb.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIngestRequestRoutes } from "./routes/ingestRequests.js";
import { registerOperationRoutes } from "./routes/operations.js";
import { registerPlayerRoutes } from "./routes/players.js";

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

app.get("/", async (_request, reply) =>
  reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Arma Attendance Tracker</title>
  </head>
  <body>
    <h1>Arma Attendance Tracker</h1>
    <p>API: online</p>
    <p>Version: ${config.appVersion}</p>
  </body>
</html>`)
);

await registerHealthRoutes(app);
await registerHealthDbRoutes(app);
await registerDebugRoutes(app);
await registerOperationRoutes(app);
await registerIngestRequestRoutes(app);
await registerPlayerRoutes(app);

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
