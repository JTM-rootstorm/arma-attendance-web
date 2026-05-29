import { config } from "../config.js";

export function getSafeReturnTo(value: string | null | undefined): string {
  if (!value) {
    return "/";
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }

  try {
    const url = new URL(value);
    if (config.oauthAllowedReturnOrigins.includes(url.origin)) {
      return url.toString();
    }
  } catch {
    return "/";
  }

  return "/";
}
