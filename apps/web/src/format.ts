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

const textEntityMap: Record<string, string> = {
  amp: "&",
  apos: "'",
  dash: "-",
  hyphen: "-",
  quot: "\""
};

function decodeTextEntity(match: string, entity: string): string {
  const normalized = entity.toLowerCase();

  if (normalized.startsWith("#x")) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  }

  if (normalized.startsWith("#")) {
    const codePoint = Number.parseInt(normalized.slice(1), 10);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  }

  return textEntityMap[normalized] ?? match;
}

export function displayPlayerName(value: string | null | undefined): string {
  const display = displayValue(value);

  if (display === "n/a") {
    return display;
  }

  return display.replace(/&(#\d+|#x[0-9a-f]+|amp|apos|dash|hyphen|quot);/gi, decodeTextEntity);
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
