import { loadEnv } from "./config/loadEnv.js";
import { envSchema } from "./config/envSchema.js";
import { buildRuntimeConfig } from "./config/runtimeConfig.js";
import { validateApplicationEnv } from "./config/validation.js";

export const loadedEnvFiles = loadEnv();

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid application configuration: ${issues}`);
}

validateApplicationEnv(parsed.data);

export const config = buildRuntimeConfig(parsed.data);
