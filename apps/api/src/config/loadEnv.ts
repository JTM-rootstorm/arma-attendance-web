import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

export type LoadedEnvFile = {
  path: string;
  loaded: boolean;
};

function resolveApiDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function findRepoRoot(startDir: string): string {
  let current = startDir;

  for (;;) {
    const packageJsonPath = path.join(current, "package.json");
    const workspacePath = path.join(current, "pnpm-workspace.yaml");
    const gitPath = path.join(current, ".git");

    if (fs.existsSync(packageJsonPath) && (fs.existsSync(workspacePath) || fs.existsSync(gitPath))) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return path.resolve(startDir, "../../..");
}

function findApiRoot(apiDir: string, repoRoot: string): string {
  let current = apiDir;

  for (;;) {
    const packageJsonPath = path.join(current, "package.json");
    const workspacePath = path.join(current, "pnpm-workspace.yaml");

    if (fs.existsSync(packageJsonPath) && !fs.existsSync(workspacePath)) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return path.join(repoRoot, "apps/api");
    }

    current = parent;
  }
}

function loadEnvFile(envFile: string, override: boolean): LoadedEnvFile {
  if (!fs.existsSync(envFile)) {
    return { path: envFile, loaded: false };
  }

  const result = dotenv.config({ path: envFile, override });

  if (result.error) {
    throw result.error;
  }

  return { path: envFile, loaded: true };
}

export function loadEnv(): LoadedEnvFile[] {
  const apiDir = resolveApiDir();
  const repoRoot = findRepoRoot(apiDir);
  const apiRoot = findApiRoot(apiDir, repoRoot);
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const allowLocalOverride = nodeEnv !== "production";

  return [
    loadEnvFile(path.join(repoRoot, ".env"), false),
    loadEnvFile(path.join(repoRoot, ".env.local"), allowLocalOverride),
    loadEnvFile(path.join(apiRoot, ".env"), false),
    loadEnvFile(path.join(apiRoot, ".env.local"), allowLocalOverride)
  ];
}
