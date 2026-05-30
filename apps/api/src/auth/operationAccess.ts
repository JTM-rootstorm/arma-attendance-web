import type { CurrentUser } from "../auth.js";
import { queryDb } from "../db/pool.js";
import { hasUnitRole } from "./units.js";

type LinkedPlayerUidRow = {
  player_uid: string;
};

type ExistsRow = {
  exists: boolean;
};

export async function getLinkedPlayerUid(user: CurrentUser): Promise<string | null> {
  const steamId = user.identities.find((identity) => identity.provider === "steam")?.provider_user_id ?? null;
  const discordId = user.identities.find((identity) => identity.provider === "discord")?.provider_user_id ?? null;

  const result = await queryDb<LinkedPlayerUidRow>(
    `
    SELECT p.player_uid
    FROM players p
    LEFT JOIN player_discord_links pdl ON pdl.player_uid = p.player_uid
    WHERE p.deleted_at IS NULL
      AND (
        ($1::text IS NOT NULL AND p.player_uid = $1)
        OR ($2::text IS NOT NULL AND pdl.discord_user_id = $2)
      )
    ORDER BY p.last_seen_at DESC
    LIMIT 1
    `,
    [steamId, discordId]
  );

  return result.rows[0]?.player_uid ?? null;
}

export async function hasAttendedOperation(user: CurrentUser, operationId: string): Promise<boolean> {
  const playerUid = await getLinkedPlayerUid(user);

  if (!playerUid) {
    return false;
  }

  const result = await queryDb<ExistsRow>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM operation_players
      WHERE operation_id = $1
        AND player_uid = $2
    ) AS exists
    `,
    [operationId, playerUid]
  );

  return result.rows[0]?.exists ?? false;
}

export async function canReadOperation(user: CurrentUser, operationId: string, unitId: string | null): Promise<boolean> {
  if (unitId === null || (await hasUnitRole(user, unitId, "officer"))) {
    return true;
  }

  return hasAttendedOperation(user, operationId);
}
