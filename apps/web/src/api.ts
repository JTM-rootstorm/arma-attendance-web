import type { ApiError } from "./types";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let csrfToken: string | null = null;
let csrfExpiresAt = 0;

export class ApiClientError extends Error {
  public readonly code: string | undefined;

  public constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
  }
}

function hasApiError(value: unknown): value is { error: ApiError } {
  return typeof value === "object" && value !== null && "error" in value;
}

export function buildUrl(path: string, params?: Record<string, string | undefined>): string {
  const url = new URL(path, apiBaseUrl || window.location.origin);

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value && value.trim().length > 0) {
      url.searchParams.set(key, value.trim());
    }
  }

  return url.toString();
}

async function getCsrfToken(): Promise<string> {
  const now = Date.now();

  if (csrfToken && csrfExpiresAt > now + 30_000) {
    return csrfToken;
  }

  const response = await fetch(buildUrl("/auth/csrf"), {
    credentials: "include"
  });
  const data = (await response.json()) as { ok: true; csrf_token: string; expires_at: string } | { ok: false; error: ApiError };

  if (!response.ok) {
    if (hasApiError(data)) {
      throw new ApiClientError(`${data.error.code}: ${data.error.message}`, data.error.code);
    }

    throw new ApiClientError(`CSRF token request failed with HTTP ${response.status}`);
  }

  if (!("csrf_token" in data)) {
    throw new ApiClientError("CSRF token response did not include a token.");
  }

  csrfToken = data.csrf_token;
  csrfExpiresAt = Date.parse(data.expires_at);
  return data.csrf_token;
}

export async function apiFetch<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    token?: string;
    params?: Record<string, string | undefined>;
    body?: unknown;
  } = {}
): Promise<T> {
  const headers = new Headers();

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const method = options.method ?? "GET";
  const init: RequestInit = {
    method,
    headers,
    credentials: "include"
  };

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  const needsCsrf = !options.token && unsafeMethods.has(method) && path !== "/auth/test/login";

  if (needsCsrf) {
    headers.set("X-CSRF-Token", await getCsrfToken());
  }

  let response = await fetch(buildUrl(path, options.params), init);
  let data = (await response.json()) as T | { ok: false; error: ApiError };

  if (!response.ok && needsCsrf && hasApiError(data) && data.error.code === "csrf_failed") {
    csrfToken = null;
    csrfExpiresAt = 0;
    headers.set("X-CSRF-Token", await getCsrfToken());
    response = await fetch(buildUrl(path, options.params), init);
    data = (await response.json()) as T | { ok: false; error: ApiError };
  }

  if (!response.ok) {
    if (hasApiError(data)) {
      throw new ApiClientError(`${data.error.code}: ${data.error.message}`, data.error.code);
    }

    throw new ApiClientError(`Request failed with HTTP ${response.status}`);
  }

  if (path === "/auth/logout") {
    csrfToken = null;
    csrfExpiresAt = 0;
  }

  return data as T;
}

export async function fetchCsv(path: string, token?: string): Promise<string> {
  const headers = new Headers();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(buildUrl(path), {
    headers,
    credentials: "include"
  });

  if (!response.ok) {
    throw new ApiClientError(`CSV export failed with HTTP ${response.status}`);
  }

  return response.text();
}
