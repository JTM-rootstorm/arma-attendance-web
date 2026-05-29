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

  if (!response.ok) {
    throw new Error(`Discord guild member fetch failed for ${guildId} with HTTP ${response.status}.`);
  }

  return (await response.json()) as DiscordCurrentGuildMember;
}
