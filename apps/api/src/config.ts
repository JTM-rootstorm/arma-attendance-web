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
}

export const config = {
  nodeEnv: env.NODE_ENV,
  appName: env.APP_NAME,
  appVersion: env.APP_VERSION,
  host: env.HOST,
  port: env.PORT,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  apiToken: env.API_TOKEN,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL
} as const;
