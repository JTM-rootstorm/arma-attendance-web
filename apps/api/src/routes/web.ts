import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { config } from "../config.js";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function findRepoRoot(startDir: string): string {
  let current = startDir;

  for (;;) {
    const packageJsonPath = path.join(current, "package.json");
    const workspacePath = path.join(current, "pnpm-workspace.yaml");

    if (fsSync.existsSync(packageJsonPath) && fsSync.existsSync(workspacePath)) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return path.resolve(startDir, "../../..");
    }

    current = parent;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function apiNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    ok: false,
    error: {
      code: "not_found",
      message: "Route not found."
    }
  });
}

function fallbackHtml(): string {
  return `<!doctype html>
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
</html>`;
}

function getRequestPath(request: FastifyRequest): string {
  const url = new URL(request.url, "http://localhost");
  return decodeURIComponent(url.pathname);
}

async function sendBuiltAsset(reply: FastifyReply, webDistPath: string, requestPath: string) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const candidate = path.resolve(webDistPath, `.${cleanPath}`);

  if (!candidate.startsWith(webDistPath)) {
    return reply.code(400).send("Bad request.");
  }

  if (await pathExists(candidate)) {
    const extension = path.extname(candidate);
    return reply.type(contentTypes[extension] ?? "application/octet-stream").send(await fs.readFile(candidate));
  }

  const indexPath = path.join(webDistPath, "index.html");

  if (await pathExists(indexPath)) {
    return reply.type("text/html; charset=utf-8").send(await fs.readFile(indexPath, "utf8"));
  }

  return reply.type("text/html; charset=utf-8").send(fallbackHtml());
}

export async function registerWebRoutes(app: FastifyInstance) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(currentDir);
  const webDistPath = path.resolve(repoRoot, "apps/web/dist");

  app.get("/*", async (request, reply) => {
    const requestPath = getRequestPath(request);

    if (requestPath.startsWith("/v1/") || requestPath.startsWith("/public/") || requestPath === "/health" || requestPath.startsWith("/health/")) {
      return apiNotFound(reply);
    }

    return sendBuiltAsset(reply, webDistPath, requestPath);
  });
}
