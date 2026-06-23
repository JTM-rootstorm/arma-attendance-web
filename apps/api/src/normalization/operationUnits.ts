import type { DbTransaction } from "../db/transactions.js";

export async function insertPrimaryOperationUnit(
  tx: DbTransaction,
  operationId: string,
  source: "server_key" | "import" = "server_key"
): Promise<{ inserted: number }> {
  const result = await tx.query(
    `
    INSERT INTO operation_units (operation_id, unit_id, source)
    SELECT id, unit_id, $2
    FROM operations
    WHERE id = $1
      AND unit_id IS NOT NULL
    ON CONFLICT (operation_id, unit_id) DO NOTHING
    `,
    [operationId, source]
  );

  return { inserted: result.rowCount ?? 0 };
}

export async function syncOperationUnitsForParticipants(
  tx: DbTransaction,
  operationId: string
): Promise<{ inserted: number }> {
  const primary = await insertPrimaryOperationUnit(tx, operationId, "server_key");
  const playerUnits = await tx.query(
    `
    WITH operation_context AS (
      SELECT id AS operation_id, unit_id AS primary_unit_id
      FROM operations
      WHERE id = $1::uuid
    ),
    participant_players AS (
      SELECT DISTINCT op.player_uid
      FROM operation_players op
      WHERE op.operation_id = $1::uuid
        AND (op.present_at_start = true OR op.present_at_end = true)
    ),
    canonical_active_unit_players AS (
      SELECT DISTINCT
        up.unit_id,
        COALESCE(
          CASE
            WHEN pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
            ELSE NULL
          END,
          up.player_uid
        ) AS player_uid
      FROM unit_players up
      JOIN units u ON u.id = up.unit_id
      LEFT JOIN player_discord_links pdl
        ON up.player_uid = ('discord:' || pdl.discord_user_id)
      WHERE up.is_active = true
        AND up.roster_status <> 'inactive'
        AND u.is_active = true
        AND u.deleted_at IS NULL
    ),
    valid_preferences AS (
      SELECT
        pp.player_uid,
        pup.represented_unit_id AS unit_id
      FROM participant_players pp
      JOIN player_unit_preferences pup
        ON pup.player_uid = pp.player_uid
      JOIN canonical_active_unit_players cup
        ON cup.player_uid = pp.player_uid
        AND cup.unit_id = pup.represented_unit_id
      WHERE pup.represented_unit_id IS NOT NULL
    ),
    fallback_memberships AS (
      SELECT DISTINCT ON (cup.player_uid)
        cup.player_uid,
        cup.unit_id
      FROM canonical_active_unit_players cup
      JOIN participant_players pp ON pp.player_uid = cup.player_uid
      JOIN unit_players up
        ON up.unit_id = cup.unit_id
        AND (
          up.player_uid = cup.player_uid
          OR EXISTS (
            SELECT 1
            FROM player_discord_links pdl
            WHERE up.player_uid = ('discord:' || pdl.discord_user_id)
              AND pdl.player_uid = cup.player_uid
          )
        )
      ORDER BY cup.player_uid, up.assignment_priority DESC, up.updated_at DESC, cup.unit_id
    ),
    selected_player_units AS (
      SELECT
        pp.player_uid,
        COALESCE(vp.unit_id, fm.unit_id, oc.primary_unit_id) AS unit_id,
        CASE
          WHEN vp.unit_id IS NOT NULL THEN 'represented_unit'
          WHEN fm.unit_id IS NOT NULL THEN 'active_membership'
          ELSE 'operation_primary'
        END AS source
      FROM participant_players pp
      CROSS JOIN operation_context oc
      LEFT JOIN valid_preferences vp ON vp.player_uid = pp.player_uid
      LEFT JOIN fallback_memberships fm ON fm.player_uid = pp.player_uid
    )
    INSERT INTO operation_player_units (operation_id, player_uid, unit_id, source)
    SELECT $1::uuid, player_uid, unit_id, source
    FROM selected_player_units
    WHERE unit_id IS NOT NULL
    ON CONFLICT (operation_id, player_uid) DO NOTHING
    `,
    [operationId]
  );
  const participants = await tx.query(
    `
    INSERT INTO operation_units (operation_id, unit_id, source)
    SELECT DISTINCT $1::uuid, unit_id, 'participant_roster'
    FROM operation_player_units
    WHERE operation_id = $1::uuid
    ON CONFLICT (operation_id, unit_id) DO NOTHING
    `,
    [operationId]
  );

  return { inserted: primary.inserted + (playerUnits.rowCount ?? 0) + (participants.rowCount ?? 0) };
}
