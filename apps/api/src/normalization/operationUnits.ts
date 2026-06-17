import type { DbTransaction } from "../db/transactions.js";

export async function insertPrimaryOperationUnit(
  tx: DbTransaction,
  operationId: string,
  source: "server_key" | "operation_primary" = "operation_primary"
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
  const primary = await insertPrimaryOperationUnit(tx, operationId, "operation_primary");
  const participants = await tx.query(
    `
    WITH canonical_unit_players AS (
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
      LEFT JOIN player_discord_links pdl
        ON up.player_uid = ('discord:' || pdl.discord_user_id)
      WHERE up.is_active = true
        AND up.roster_status <> 'inactive'
    ),
    participant_units AS (
      SELECT DISTINCT cup.unit_id
      FROM operation_players op
      JOIN canonical_unit_players cup ON cup.player_uid = op.player_uid
      WHERE op.operation_id = $1
        AND (op.present_at_start = true OR op.present_at_end = true)
    )
    INSERT INTO operation_units (operation_id, unit_id, source)
    SELECT $1, unit_id, 'participant_roster'
    FROM participant_units
    ON CONFLICT (operation_id, unit_id) DO NOTHING
    `,
    [operationId]
  );

  return { inserted: primary.inserted + (participants.rowCount ?? 0) };
}
