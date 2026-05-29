import type { ApiResult } from "./types";

export const emptyResult: ApiResult<never> = {
  status: "idle",
  data: null,
  error: null
};

export function displayValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }

  return String(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

export function statusLabel(result: ApiResult<unknown>): string {
  if (result.status === "loading") {
    return "checking";
  }

  if (result.status === "ready") {
    return "online";
  }

  if (result.status === "error") {
    return "fault";
  }

  return "idle";
}

export function resultError(error: unknown, fallback: string): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;

    return {
      message: error.message,
      ...(code ? { code } : {})
    };
  }

  return { message: fallback };
}
