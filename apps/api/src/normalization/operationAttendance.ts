import type { DbTransaction } from "../db/transactions.js";
import { normalizePlayersFromPayload, type NormalizedPlayer } from "./players.js";

export type NormalizationSummary = {
  players_seen: number;
  players_ignored_missing_uid: number;
  stats_seen: number;
};

type AttendancePhase = "start" | "finish";

async function upsertPlayer(tx: DbTransaction, player: NormalizedPlayer): Promise<void> {
  await tx.query(
    `
    INSERT INTO players (
      player_uid,
      last_name,
      raw_last_player
    )
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (player_uid) DO UPDATE
    SET
      last_name = CASE
        WHEN players.last_name IS NULL OR btrim(players.last_name) = ''
        THEN EXCLUDED.last_name
        ELSE players.last_name
      END,
      last_seen_at = now(),
      raw_last_player = EXCLUDED.raw_last_player,
      updated_at = now()
    `,
    [player.playerUid, player.name, JSON.stringify(player.rawPlayer)]
  );
}

async function upsertStartAttendance(
  tx: DbTransaction,
  operationId: string,
  player: NormalizedPlayer
): Promise<void> {
  await tx.query(
    `
    INSERT INTO operation_players (
      operation_id,
      player_uid,
      name_at_start,
      side_at_start,
      group_at_start,
      role_at_start,
      unit_class_at_start,
      vehicle_class_at_start,
      present_at_start,
      raw_start_player
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9::jsonb)
    ON CONFLICT (operation_id, player_uid) DO UPDATE
    SET
      name_at_start = EXCLUDED.name_at_start,
      side_at_start = EXCLUDED.side_at_start,
      group_at_start = EXCLUDED.group_at_start,
      role_at_start = EXCLUDED.role_at_start,
      unit_class_at_start = EXCLUDED.unit_class_at_start,
      vehicle_class_at_start = EXCLUDED.vehicle_class_at_start,
      present_at_start = true,
      raw_start_player = EXCLUDED.raw_start_player,
      updated_at = now()
    `,
    [
      operationId,
      player.playerUid,
      player.name,
      player.side,
      player.group,
      player.role,
      player.unitClass,
      player.vehicleClass,
      JSON.stringify(player.rawPlayer)
    ]
  );
}

async function upsertFinishAttendance(
  tx: DbTransaction,
  operationId: string,
  player: NormalizedPlayer
): Promise<void> {
  await tx.query(
    `
    INSERT INTO operation_players (
      operation_id,
      player_uid,
      name_at_end,
      side_at_end,
      group_at_end,
      role_at_end,
      unit_class_at_end,
      vehicle_class_at_end,
      present_at_end,
      raw_end_player
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9::jsonb)
    ON CONFLICT (operation_id, player_uid) DO UPDATE
    SET
      name_at_end = EXCLUDED.name_at_end,
      side_at_end = EXCLUDED.side_at_end,
      group_at_end = EXCLUDED.group_at_end,
      role_at_end = EXCLUDED.role_at_end,
      unit_class_at_end = EXCLUDED.unit_class_at_end,
      vehicle_class_at_end = EXCLUDED.vehicle_class_at_end,
      present_at_end = true,
      raw_end_player = EXCLUDED.raw_end_player,
      updated_at = now()
    `,
    [
      operationId,
      player.playerUid,
      player.name,
      player.side,
      player.group,
      player.role,
      player.unitClass,
      player.vehicleClass,
      JSON.stringify(player.rawPlayer)
    ]
  );
}

async function upsertPlayerStats(tx: DbTransaction, operationId: string, player: NormalizedPlayer): Promise<void> {
  if (!player.stats || !player.rawStats) {
    return;
  }

  await tx.query(
    `
    INSERT INTO operation_player_stats (
      operation_id,
      player_uid,
      infantry_kills,
      vehicle_kills,
      player_kills,
      ai_kills,
      friendly_kills,
      deaths,
      raw_stats,
      soft_vehicle_kills,
      armor_kills,
      air_kills,
      ground_vehicle_kills,
      all_vehicle_kills,
      scoreboard_score,
      stats_source,
      scoreboard_baseline,
      scoreboard_latest,
      raw_scoreboard_stats
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19::jsonb)
    ON CONFLICT (operation_id, player_uid) DO UPDATE
    SET
      infantry_kills = EXCLUDED.infantry_kills,
      vehicle_kills = EXCLUDED.vehicle_kills,
      player_kills = EXCLUDED.player_kills,
      ai_kills = EXCLUDED.ai_kills,
      friendly_kills = EXCLUDED.friendly_kills,
      deaths = EXCLUDED.deaths,
      raw_stats = EXCLUDED.raw_stats,
      soft_vehicle_kills = EXCLUDED.soft_vehicle_kills,
      armor_kills = EXCLUDED.armor_kills,
      air_kills = EXCLUDED.air_kills,
      ground_vehicle_kills = EXCLUDED.ground_vehicle_kills,
      all_vehicle_kills = EXCLUDED.all_vehicle_kills,
      scoreboard_score = EXCLUDED.scoreboard_score,
      stats_source = EXCLUDED.stats_source,
      scoreboard_baseline = EXCLUDED.scoreboard_baseline,
      scoreboard_latest = EXCLUDED.scoreboard_latest,
      raw_scoreboard_stats = EXCLUDED.raw_scoreboard_stats,
      updated_at = now()
    `,
    [
      operationId,
      player.playerUid,
      player.stats.infantry_kills,
      player.stats.vehicle_kills,
      player.stats.player_kills,
      player.stats.ai_kills,
      player.stats.friendly_kills,
      player.stats.deaths,
      JSON.stringify(player.rawStats),
      player.scoreboardStats?.soft_vehicle_kills ?? 0,
      player.scoreboardStats?.armor_kills ?? 0,
      player.scoreboardStats?.air_kills ?? 0,
      player.scoreboardStats?.ground_vehicle_kills ?? 0,
      player.scoreboardStats?.all_vehicle_kills ?? 0,
      player.scoreboardStats?.score ?? 0,
      player.scoreboardStats?.stats_source ?? null,
      JSON.stringify(player.scoreboardStats?.baseline ?? []),
      JSON.stringify(player.scoreboardStats?.latest ?? []),
      JSON.stringify(player.rawScoreboardStats ?? {})
    ]
  );
}

export async function persistOperationAttendance(
  tx: DbTransaction,
  operationId: string,
  phase: AttendancePhase,
  payload: unknown
): Promise<NormalizationSummary> {
  const normalized = normalizePlayersFromPayload(payload, phase);

  for (const player of normalized.players) {
    await upsertPlayer(tx, player);

    if (phase === "start") {
      await upsertStartAttendance(tx, operationId, player);
    } else {
      await upsertFinishAttendance(tx, operationId, player);
      await upsertPlayerStats(tx, operationId, player);
    }
  }

  return {
    players_seen: normalized.players.length,
    players_ignored_missing_uid: normalized.ignoredMissingUid,
    stats_seen: phase === "finish" ? normalized.statsSeen : 0
  };
}
