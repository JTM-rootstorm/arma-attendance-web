export type DiscordOAuthToken = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

export type DiscordCurrentGuildMember = {
  user?: {
    id: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
  };
  nick?: string | null;
  roles: string[];
  joined_at?: string | null;
};

export class DiscordRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  readonly statusCode = 429;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "DiscordRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function getRetryAfterSeconds(response: Response): Promise<number> {
  const retryAfter = response.headers.get("retry-after");

  if (retryAfter && Number.isFinite(Number(retryAfter))) {
    return Number(retryAfter);
  }

  const resetAfter = response.headers.get("x-ratelimit-reset-after");

  if (resetAfter && Number.isFinite(Number(resetAfter))) {
    return Number(resetAfter);
  }

  try {
    const body = (await response.clone().json()) as { retry_after?: unknown };

    if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) {
      return body.retry_after;
    }
  } catch {
    // Discord may send an empty or non-JSON rate-limit response.
  }

  return 5;
}

export async function fetchCurrentUserGuildMember(
  token: DiscordOAuthToken,
  guildId: string
): Promise<DiscordCurrentGuildMember | null> {
  const response = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `${token.token_type} ${token.access_token}` }
  });

  if (response.status === 403 || response.status === 404) {
    return null;
  }

  if (response.status === 429) {
    throw new DiscordRateLimitError(
      `Discord rate limited guild member fetch for ${guildId}.`,
      await getRetryAfterSeconds(response)
    );
  }

  if (!response.ok) {
    throw new Error(`Discord guild member fetch failed for ${guildId} with HTTP ${response.status}.`);
  }

  return (await response.json()) as DiscordCurrentGuildMember;
}
