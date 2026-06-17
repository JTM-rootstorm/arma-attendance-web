import type { DbTransaction } from "../db/transactions.js";

export type PlayerCanonicalizationSource =
  | "steam_link"
  | "auth_roster_repair"
  | "discord_bot_assignment"
  | "migration";

export type PlayerCanonicalizationResult = {
  mergedPlaceholderUid: string | null;
  unitPlayersMoved: number;
  unitRosterAssignmentsMoved: number;
  operationPlayersMoved: number;
  operationStatsMoved: number;
  discordLinksUpdated: number;
};

export function isDiscordPlaceholderUid(playerUid: string): boolean {
  return playerUid.startsWith("discord:") && playerUid.length > "discord:".length;
}

export function discordIdFromPlaceholderUid(playerUid: string): string | null {
  return isDiscordPlaceholderUid(playerUid) ? playerUid.slice("discord:".length) : null;
}

export async function canonicalizeDiscordLinkedPlayer(
  tx: DbTransaction,
  input: {
    discordUserId: string;
    canonicalPlayerUid: string;
    displayName?: string | null;
    actorUserId?: string | null;
    source: PlayerCanonicalizationSource;
  }
): Promise<PlayerCanonicalizationResult> {
  const fromUid = `discord:${input.discordUserId}`;
  const toUid = input.canonicalPlayerUid;

  if (fromUid === toUid || isDiscordPlaceholderUid(toUid)) {
    return {
      mergedPlaceholderUid: null,
      unitPlayersMoved: 0,
      unitRosterAssignmentsMoved: 0,
      operationPlayersMoved: 0,
      operationStatsMoved: 0,
      discordLinksUpdated: 0
    };
  }

  await tx.query(
    `
    INSERT INTO players (player_uid, last_name, raw_last_player)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (player_uid) DO UPDATE
    SET
      last_name = COALESCE(players.last_name, EXCLUDED.last_name),
      deleted_at = NULL,
      updated_at = now()
    `,
    [
      toUid,
      input.displayName ?? null,
      JSON.stringify({
        source: "player_canonicalization",
        canonicalized_from: fromUid,
        discord_user_id: input.discordUserId
      })
    ]
  );

  const linkResult = await tx.query(
    `
    UPDATE player_discord_links
    SET
      player_uid = $2,
      verified_at = COALESCE(verified_at, now()),
      raw_link = raw_link || $3::jsonb,
      updated_at = now()
    WHERE discord_user_id = $1
      AND (
        player_uid = $4
        OR player_uid LIKE 'discord:%'
        OR source IN ('auth', 'bot')
      )
      AND NOT (
        source = 'manual'
        AND player_uid <> $4
        AND player_uid NOT LIKE 'discord:%'
        AND player_uid <> $2
      )
    `,
    [
      input.discordUserId,
      toUid,
      JSON.stringify({
        canonicalized_by: "runtime",
        canonicalization_source: input.source,
        previous_placeholder_uid: fromUid
      }),
      fromUid
    ]
  );

  const unitPlayersResult = await tx.query(
    `
    WITH moved AS (
      SELECT *
      FROM unit_players
      WHERE player_uid = $1
    ),
    upserted AS (
      INSERT INTO unit_players (
        unit_id,
        player_uid,
        rank,
        roster_name,
        is_active,
        notes,
        rank_sort,
        roster_status,
        joined_unit_at,
        left_unit_at,
        assignment_source,
        rank_id,
        assignment_locked,
        assignment_priority,
        source_guild_id,
        source_role_id
      )
      SELECT
        unit_id,
        $2,
        rank,
        roster_name,
        is_active,
        notes,
        rank_sort,
        roster_status,
        joined_unit_at,
        left_unit_at,
        assignment_source,
        rank_id,
        assignment_locked,
        assignment_priority,
        source_guild_id,
        source_role_id
      FROM moved
      ON CONFLICT (unit_id, player_uid) DO UPDATE
      SET
        rank = CASE
          WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.rank
          ELSE COALESCE(unit_players.rank, EXCLUDED.rank)
        END,
        roster_name = CASE
          WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.roster_name
          ELSE COALESCE(NULLIF(unit_players.roster_name, ''), EXCLUDED.roster_name)
        END,
        is_active = unit_players.is_active OR EXCLUDED.is_active,
        notes = COALESCE(unit_players.notes, EXCLUDED.notes),
        rank_sort = CASE
          WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.rank_sort
          ELSE GREATEST(unit_players.rank_sort, EXCLUDED.rank_sort)
        END,
        roster_status = CASE
          WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.roster_status
          WHEN unit_players.roster_status = 'active' OR EXCLUDED.roster_status = 'active' THEN 'active'
          WHEN unit_players.roster_status = 'reserve' OR EXCLUDED.roster_status = 'reserve' THEN 'reserve'
          WHEN unit_players.roster_status = 'loa' OR EXCLUDED.roster_status = 'loa' THEN 'loa'
          ELSE COALESCE(unit_players.roster_status, EXCLUDED.roster_status)
        END,
        joined_unit_at = COALESCE(unit_players.joined_unit_at, EXCLUDED.joined_unit_at),
        left_unit_at = CASE
          WHEN unit_players.is_active OR EXCLUDED.is_active THEN NULL
          ELSE COALESCE(unit_players.left_unit_at, EXCLUDED.left_unit_at)
        END,
        assignment_source = CASE
          WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.assignment_source
          ELSE COALESCE(NULLIF(unit_players.assignment_source, ''), EXCLUDED.assignment_source)
        END,
        rank_id = CASE
          WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.rank_id
          ELSE COALESCE(unit_players.rank_id, EXCLUDED.rank_id)
        END,
        assignment_locked = unit_players.assignment_locked OR EXCLUDED.assignment_locked,
        assignment_priority = GREATEST(unit_players.assignment_priority, EXCLUDED.assignment_priority),
        source_guild_id = COALESCE(unit_players.source_guild_id, EXCLUDED.source_guild_id),
        source_role_id = COALESCE(unit_players.source_role_id, EXCLUDED.source_role_id),
        updated_at = now()
      RETURNING unit_id
    ),
    deleted AS (
      DELETE FROM unit_players
      WHERE player_uid = $1
      RETURNING unit_id
    )
    SELECT COUNT(*)::int AS moved_count FROM deleted
    `,
    [fromUid, toUid]
  );

  const rosterAssignmentsResult = await tx.query(
    `
    UPDATE unit_roster_assignments
    SET player_uid = $2,
        updated_at = now()
    WHERE player_uid = $1
    `,
    [fromUid, toUid]
  );

  const operationPlayersResult = await tx.query(
    `
    WITH moved AS (
      SELECT *
      FROM operation_players
      WHERE player_uid = $1
    ),
    upserted AS (
      INSERT INTO operation_players (
        operation_id,
        player_uid,
        name_at_start,
        name_at_end,
        side_at_start,
        side_at_end,
        group_at_start,
        group_at_end,
        role_at_start,
        role_at_end,
        unit_class_at_start,
        unit_class_at_end,
        vehicle_class_at_start,
        vehicle_class_at_end,
        present_at_start,
        present_at_end,
        raw_start_player,
        raw_end_player
      )
      SELECT
        operation_id,
        $2,
        name_at_start,
        name_at_end,
        side_at_start,
        side_at_end,
        group_at_start,
        group_at_end,
        role_at_start,
        role_at_end,
        unit_class_at_start,
        unit_class_at_end,
        vehicle_class_at_start,
        vehicle_class_at_end,
        present_at_start,
        present_at_end,
        raw_start_player,
        raw_end_player
      FROM moved
      ON CONFLICT (operation_id, player_uid) DO UPDATE
      SET
        name_at_start = COALESCE(operation_players.name_at_start, EXCLUDED.name_at_start),
        name_at_end = COALESCE(operation_players.name_at_end, EXCLUDED.name_at_end),
        side_at_start = COALESCE(operation_players.side_at_start, EXCLUDED.side_at_start),
        side_at_end = COALESCE(operation_players.side_at_end, EXCLUDED.side_at_end),
        group_at_start = COALESCE(operation_players.group_at_start, EXCLUDED.group_at_start),
        group_at_end = COALESCE(operation_players.group_at_end, EXCLUDED.group_at_end),
        role_at_start = COALESCE(operation_players.role_at_start, EXCLUDED.role_at_start),
        role_at_end = COALESCE(operation_players.role_at_end, EXCLUDED.role_at_end),
        unit_class_at_start = COALESCE(operation_players.unit_class_at_start, EXCLUDED.unit_class_at_start),
        unit_class_at_end = COALESCE(operation_players.unit_class_at_end, EXCLUDED.unit_class_at_end),
        vehicle_class_at_start = COALESCE(operation_players.vehicle_class_at_start, EXCLUDED.vehicle_class_at_start),
        vehicle_class_at_end = COALESCE(operation_players.vehicle_class_at_end, EXCLUDED.vehicle_class_at_end),
        present_at_start = operation_players.present_at_start OR EXCLUDED.present_at_start,
        present_at_end = operation_players.present_at_end OR EXCLUDED.present_at_end,
        raw_start_player = COALESCE(operation_players.raw_start_player, EXCLUDED.raw_start_player),
        raw_end_player = COALESCE(operation_players.raw_end_player, EXCLUDED.raw_end_player),
        updated_at = now()
      RETURNING operation_id
    ),
    deleted AS (
      DELETE FROM operation_players
      WHERE player_uid = $1
      RETURNING operation_id
    )
    SELECT COUNT(*)::int AS moved_count FROM deleted
    `,
    [fromUid, toUid]
  );

  const operationStatsResult = await tx.query(
    `
    WITH moved AS (
      SELECT *
      FROM operation_player_stats
      WHERE player_uid = $1
    ),
    inserted AS (
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
      SELECT
        operation_id,
        $2,
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
      FROM moved
      ON CONFLICT (operation_id, player_uid) DO NOTHING
      RETURNING operation_id
    ),
    deleted AS (
      DELETE FROM operation_player_stats
      WHERE player_uid = $1
      RETURNING operation_id
    )
    SELECT COUNT(*)::int AS moved_count FROM deleted
    `,
    [fromUid, toUid]
  );

  await tx.query(
    `
    DELETE FROM players p
    WHERE p.player_uid = $1
      AND NOT EXISTS (SELECT 1 FROM player_discord_links pdl WHERE pdl.player_uid = p.player_uid)
      AND NOT EXISTS (SELECT 1 FROM unit_players up WHERE up.player_uid = p.player_uid)
      AND NOT EXISTS (SELECT 1 FROM unit_roster_assignments ura WHERE ura.player_uid = p.player_uid)
      AND NOT EXISTS (SELECT 1 FROM operation_players op WHERE op.player_uid = p.player_uid)
      AND NOT EXISTS (SELECT 1 FROM operation_player_stats ops WHERE ops.player_uid = p.player_uid)
    `,
    [fromUid]
  );

  const summary = {
    discord_user_id: input.discordUserId,
    from_player_uid: fromUid,
    to_player_uid: toUid,
    source: input.source,
    unit_players_moved: unitPlayersResult.rows[0]?.moved_count ?? 0,
    unit_roster_assignments_moved: rosterAssignmentsResult.rowCount ?? 0,
    operation_players_moved: operationPlayersResult.rows[0]?.moved_count ?? 0,
    operation_stats_moved: operationStatsResult.rows[0]?.moved_count ?? 0,
    discord_links_updated: linkResult.rowCount ?? 0
  };

  await tx.query(
    `
    INSERT INTO admin_audit_events (actor_user_id, actor_label, action, target_user_id, details)
    VALUES ($1, 'system', 'canonicalize_discord_player_identity', $1, $2::jsonb)
    `,
    [input.actorUserId ?? null, JSON.stringify(summary)]
  );

  return {
    mergedPlaceholderUid: fromUid,
    unitPlayersMoved: summary.unit_players_moved,
    unitRosterAssignmentsMoved: summary.unit_roster_assignments_moved,
    operationPlayersMoved: summary.operation_players_moved,
    operationStatsMoved: summary.operation_stats_moved,
    discordLinksUpdated: summary.discord_links_updated
  };
}
