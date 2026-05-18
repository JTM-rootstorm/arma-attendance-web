import type { ApiError } from "./types";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

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

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    credentials: "include"
  };

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(buildUrl(path, options.params), init);
  const data = (await response.json()) as T | { ok: false; error: ApiError };

  if (!response.ok) {
    if (hasApiError(data)) {
      throw new ApiClientError(`${data.error.code}: ${data.error.message}`, data.error.code);
    }

    throw new ApiClientError(`Request failed with HTTP ${response.status}`);
  }

  return data as T;
}

export async function fetchCsv(path: string, token: string): Promise<string> {
  const response = await fetch(buildUrl(path), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new ApiClientError(`CSV export failed with HTTP ${response.status}`);
  }

  return response.text();
}
