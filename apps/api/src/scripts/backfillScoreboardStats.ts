import { closeDbPool, queryDb } from "../db/pool.js";
import { normalizePlayersFromPayload } from "../normalization/players.js";

type PayloadRow = {
  operation_id: string;
  payload: unknown;
};

async function main() {
  const payloads = await queryDb<PayloadRow>(
    `
    SELECT operation_id, payload
    FROM operation_payloads
    WHERE kind = 'finish'
      AND (
        payload ? 'scoreboard_stats'
        OR payload @? '$.players[*].scoreboard_stats'
        OR payload @? '$.attendance_records[*].scoreboard_stats'
      )
    ORDER BY received_at ASC
    `
  );

  let playersSeen = 0;
  let statsUpdated = 0;

  for (const row of payloads.rows) {
    const normalized = normalizePlayersFromPayload(row.payload, "finish");
    playersSeen += normalized.players.length;

    for (const player of normalized.players) {
      if (!player.scoreboardStats || !player.rawScoreboardStats || !player.stats || !player.rawStats) {
        continue;
      }

      await queryDb(
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

      await queryDb(
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
          name_at_end = COALESCE(EXCLUDED.name_at_end, operation_players.name_at_end),
          side_at_end = COALESCE(EXCLUDED.side_at_end, operation_players.side_at_end),
          group_at_end = COALESCE(EXCLUDED.group_at_end, operation_players.group_at_end),
          role_at_end = COALESCE(EXCLUDED.role_at_end, operation_players.role_at_end),
          unit_class_at_end = COALESCE(EXCLUDED.unit_class_at_end, operation_players.unit_class_at_end),
          vehicle_class_at_end = COALESCE(EXCLUDED.vehicle_class_at_end, operation_players.vehicle_class_at_end),
          present_at_end = true,
          raw_end_player = EXCLUDED.raw_end_player,
          updated_at = now()
        `,
        [
          row.operation_id,
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

      await queryDb(
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
          row.operation_id,
          player.playerUid,
          player.stats.infantry_kills,
          player.stats.vehicle_kills,
          player.stats.player_kills,
          player.stats.ai_kills,
          player.stats.friendly_kills,
          player.stats.deaths,
          JSON.stringify(player.rawStats),
          player.scoreboardStats.soft_vehicle_kills,
          player.scoreboardStats.armor_kills,
          player.scoreboardStats.air_kills,
          player.scoreboardStats.ground_vehicle_kills,
          player.scoreboardStats.all_vehicle_kills,
          player.scoreboardStats.score,
          player.scoreboardStats.stats_source,
          JSON.stringify(player.scoreboardStats.baseline),
          JSON.stringify(player.scoreboardStats.latest),
          JSON.stringify(player.rawScoreboardStats)
        ]
      );

      statsUpdated += 1;
    }
  }

  console.log(JSON.stringify({ ok: true, payloads_seen: payloads.rows.length, players_seen: playersSeen, stats_updated: statsUpdated }));
}

try {
  await main();
} finally {
  await closeDbPool();
}
