export type SafeDbErrorDetails = {
  name: string;
  code?: string;
};

export function getSafeDbErrorDetails(error: unknown): SafeDbErrorDetails {
  const details: SafeDbErrorDetails = {
    name: error instanceof Error ? error.name : typeof error
  };

  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;

    if (typeof code === "string") {
      details.code = code;
    }
  }

  return details;
}
