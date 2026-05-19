import "../config.js";

import { closeDbPool, queryDb } from "../db/pool.js";

const unitKey = process.env.DEFAULT_UNIT_SLUG?.trim() || "tcw";
const unitName = process.env.DEFAULT_UNIT_NAME?.trim() || "TCW";
const shouldMapOperations = process.argv.includes("--map-operations");
const shouldMapPlayers = process.argv.includes("--map-players");

try {
  const unitResult = await queryDb<{ id: string }>(
    `
    INSERT INTO units (unit_key, slug, name, description)
    VALUES ($1, $1, $2, 'Default unit backfilled from existing data')
    ON CONFLICT (unit_key) DO UPDATE
    SET
      slug = COALESCE(units.slug, EXCLUDED.slug),
      name = EXCLUDED.name,
      updated_at = now()
    RETURNING id
    `,
    [unitKey, unitName]
  );
  const unitId = unitResult.rows[0]?.id;

  if (!unitId) {
    throw new Error("Default unit upsert returned no row.");
  }

  let operationsMapped = 0;
  let playersMapped = 0;

  if (shouldMapOperations) {
    const result = await queryDb<{ count: number }>(
      `
      WITH updated AS (
        UPDATE operations
        SET unit_id = $1, updated_at = now()
        WHERE unit_id IS NULL
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM updated
      `,
      [unitId]
    );
    operationsMapped = result.rows[0]?.count ?? 0;

    await queryDb(
      `
      INSERT INTO operation_units (operation_id, unit_id, source)
      SELECT id, unit_id, 'import'
      FROM operations
      WHERE unit_id = $1
      ON CONFLICT (operation_id, unit_id) DO NOTHING
      `,
      [unitId]
    );
  }

  if (shouldMapPlayers) {
    const result = await queryDb<{ count: number }>(
      `
      WITH inserted AS (
        INSERT INTO unit_players (unit_id, player_uid, roster_name)
        SELECT $1, player_uid, last_name
        FROM players
        ON CONFLICT (unit_id, player_uid) DO NOTHING
        RETURNING player_uid
      )
      SELECT COUNT(*)::int AS count FROM inserted
      `,
      [unitId]
    );
    playersMapped = result.rows[0]?.count ?? 0;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        unit: { id: unitId, unit_key: unitKey, name: unitName },
        operations_mapped: operationsMapped,
        players_mapped: playersMapped
      },
      null,
      2
    )
  );
} finally {
  await closeDbPool();
}
