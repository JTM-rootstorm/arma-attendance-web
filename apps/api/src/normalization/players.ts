export type PlayerStats = {
  infantry_kills: number;
  vehicle_kills: number;
  player_kills: number;
  ai_kills: number;
  friendly_kills: number;
  deaths: number;
};

export type ScoreboardStats = {
  stats_source: string | null;
  infantry_kills: number;
  soft_vehicle_kills: number;
  armor_kills: number;
  ground_vehicle_kills: number;
  air_kills: number;
  all_vehicle_kills: number;
  deaths: number;
  score: number;
  baseline: unknown[];
  latest: unknown[];
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
  scoreboardStats: ScoreboardStats | null;
  rawScoreboardStats: Record<string, unknown> | null;
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

const scoreboardIntegerFields = [
  "infantry_kills",
  "soft_vehicle_kills",
  "armor_kills",
  "ground_vehicle_kills",
  "air_kills",
  "all_vehicle_kills",
  "deaths",
  "score"
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

function getInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.trunc(value);
}

function getIntegerStat(record: Record<string, unknown>, key: (typeof integerStatFields)[number]): number {
  return getInteger(record, key);
}

function getScoreboardInteger(record: Record<string, unknown>, key: (typeof scoreboardIntegerFields)[number]): number {
  return getInteger(record, key);
}

function getArrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function normalizeScoreboardStats(value: unknown): { stats: ScoreboardStats; rawScoreboardStats: Record<string, unknown> } | null {
  if (!isRecord(value)) {
    return null;
  }

  const groundVehicleKills = getScoreboardInteger(value, "ground_vehicle_kills");
  const softVehicleKills = getScoreboardInteger(value, "soft_vehicle_kills");
  const armorKills = getScoreboardInteger(value, "armor_kills");
  const airKills = getScoreboardInteger(value, "air_kills");
  const allVehicleKills = getScoreboardInteger(value, "all_vehicle_kills");

  return {
    rawScoreboardStats: value,
    stats: {
      stats_source: getFirstNonEmptyString(value, ["stats_source"]),
      infantry_kills: getScoreboardInteger(value, "infantry_kills"),
      soft_vehicle_kills: softVehicleKills,
      armor_kills: armorKills,
      ground_vehicle_kills: groundVehicleKills || softVehicleKills + armorKills,
      air_kills: airKills,
      all_vehicle_kills: allVehicleKills || softVehicleKills + armorKills + airKills,
      deaths: getScoreboardInteger(value, "deaths"),
      score: getScoreboardInteger(value, "score"),
      baseline: getArrayField(value, "baseline"),
      latest: getArrayField(value, "latest")
    }
  };
}

export function normalizeLegacyStats(value: unknown, scoreboardStats?: ScoreboardStats | null): { stats: PlayerStats; rawStats: Record<string, unknown> } | null {
  if (!isRecord(value)) {
    if (!scoreboardStats) {
      return null;
    }

    return {
      rawStats: {},
      stats: {
        infantry_kills: scoreboardStats.infantry_kills,
        vehicle_kills: scoreboardStats.all_vehicle_kills,
        player_kills: 0,
        ai_kills: scoreboardStats.infantry_kills,
        friendly_kills: 0,
        deaths: scoreboardStats.deaths
      }
    };
  }

  return {
    rawStats: value,
    stats: {
      infantry_kills: getIntegerStat(value, "infantry_kills") || scoreboardStats?.infantry_kills || 0,
      vehicle_kills: getIntegerStat(value, "vehicle_kills") || scoreboardStats?.all_vehicle_kills || 0,
      player_kills: getIntegerStat(value, "player_kills"),
      ai_kills: getIntegerStat(value, "ai_kills") || scoreboardStats?.infantry_kills || 0,
      friendly_kills: getIntegerStat(value, "friendly_kills"),
      deaths: getIntegerStat(value, "deaths") || scoreboardStats?.deaths || 0
    }
  };
}

function normalizePlayerEntry(entry: Record<string, unknown>): NormalizedPlayer | null {
  const playerUid = getFirstNonEmptyString(entry, playerUidFields);

  if (!playerUid) {
    return null;
  }

  const scoreboardResult = normalizeScoreboardStats(entry.scoreboard_stats);
  const statsResult = normalizeLegacyStats(entry.stats, scoreboardResult?.stats ?? null);

  return {
    playerUid,
    name: getFirstNonEmptyString(entry, nameFields),
    side: getMetadataField(entry, "side", "side_name"),
    group: getMetadataField(entry, "group", "group_name"),
    role: getMetadataField(entry, "role", "role_name"),
    unitClass: getMetadataField(entry, "unit_class"),
    vehicleClass: getMetadataField(entry, "vehicle_class"),
    rawPlayer: entry,
    stats: statsResult?.stats ?? null,
    rawStats: statsResult?.rawStats ?? null,
    scoreboardStats: scoreboardResult?.stats ?? null,
    rawScoreboardStats: scoreboardResult?.rawScoreboardStats ?? null
  };
}

export function normalizePlayersFromPayload(payload: unknown, phase: "start" | "finish" = "start"): NormalizedPlayersResult {
  if (!isRecord(payload)) {
    return {
      players: [],
      ignoredMissingUid: 0,
      statsSeen: 0
    };
  }

  const players: NormalizedPlayer[] = [];
  let ignoredMissingUid = 0;
  let statsSeen = 0;
  const seen = new Set<string>();
  const sourceEntries = phase === "finish"
    ? [
        ...(Array.isArray(payload.attendance_records) ? payload.attendance_records : []),
        ...(Array.isArray(payload.players) ? payload.players : [])
      ]
    : (Array.isArray(payload.players) ? payload.players : []);

  for (const entry of sourceEntries) {
    if (!isRecord(entry)) {
      ignoredMissingUid += 1;
      continue;
    }

    const player = normalizePlayerEntry(entry);

    if (!player) {
      ignoredMissingUid += 1;
      continue;
    }

    if (seen.has(player.playerUid)) {
      continue;
    }

    seen.add(player.playerUid);

    if (player.stats || player.scoreboardStats) {
      statsSeen += 1;
    }

    players.push(player);
  }

  return {
    players,
    ignoredMissingUid,
    statsSeen
  };
}
