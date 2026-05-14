import type { FastifyInstance } from "fastify";

import { config } from "../config.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    ok: true,
    service: "arma-attendance-api",
    version: config.appVersion,
    time: new Date().toISOString()
  }));
}
