export type PlayerStats = {
  infantry_kills: number;
  vehicle_kills: number;
  player_kills: number;
  ai_kills: number;
  friendly_kills: number;
  deaths: number;
};

export type NormalizedPlayer = {
  playerUid: string;
  name: string | null;
  side: string | null;
  group: string | null;
  role: string | null;
  unitClass: string | null;
  vehicleClass: string | null;
  rawPlayer: Record<string, unknown>;
  stats: PlayerStats | null;
  rawStats: Record<string, unknown> | null;
};

export type NormalizedPlayersResult = {
  players: NormalizedPlayer[];
  ignoredMissingUid: number;
  statsSeen: number;
};

const playerUidFields = ["player_uid", "arma_uid", "steam_id", "uid"] as const;
const nameFields = ["name", "player_name", "display_name"] as const;
const integerStatFields = [
  "infantry_kills",
  "vehicle_kills",
  "player_kills",
  "ai_kills",
  "friendly_kills",
  "deaths"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFirstNonEmptyString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function getMetadataField(record: Record<string, unknown>, primaryKey: string, variantKey?: string): string | null {
  return getFirstNonEmptyString(record, variantKey ? [primaryKey, variantKey] : [primaryKey]);
}

function getIntegerStat(record: Record<string, unknown>, key: (typeof integerStatFields)[number]): number {
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.trunc(value);
}

function normalizeStats(value: unknown): { stats: PlayerStats; rawStats: Record<string, unknown> } | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    rawStats: value,
    stats: {
      infantry_kills: getIntegerStat(value, "infantry_kills"),
      vehicle_kills: getIntegerStat(value, "vehicle_kills"),
      player_kills: getIntegerStat(value, "player_kills"),
      ai_kills: getIntegerStat(value, "ai_kills"),
      friendly_kills: getIntegerStat(value, "friendly_kills"),
      deaths: getIntegerStat(value, "deaths")
    }
  };
}

export function normalizePlayersFromPayload(payload: unknown): NormalizedPlayersResult {
  if (!isRecord(payload) || !Array.isArray(payload.players)) {
    return {
      players: [],
      ignoredMissingUid: 0,
      statsSeen: 0
    };
  }

  const players: NormalizedPlayer[] = [];
  let ignoredMissingUid = 0;
  let statsSeen = 0;

  for (const entry of payload.players) {
    if (!isRecord(entry)) {
      ignoredMissingUid += 1;
      continue;
    }

    const playerUid = getFirstNonEmptyString(entry, playerUidFields);

    if (!playerUid) {
      ignoredMissingUid += 1;
      continue;
    }

    const statsResult = normalizeStats(entry.stats);

    if (statsResult) {
      statsSeen += 1;
    }

    players.push({
      playerUid,
      name: getFirstNonEmptyString(entry, nameFields),
      side: getMetadataField(entry, "side", "side_name"),
      group: getMetadataField(entry, "group", "group_name"),
      role: getMetadataField(entry, "role", "role_name"),
      unitClass: getMetadataField(entry, "unit_class"),
      vehicleClass: getMetadataField(entry, "vehicle_class"),
      rawPlayer: entry,
      stats: statsResult?.stats ?? null,
      rawStats: statsResult?.rawStats ?? null
    });
  }

  return {
    players,
    ignoredMissingUid,
    statsSeen
  };
}
