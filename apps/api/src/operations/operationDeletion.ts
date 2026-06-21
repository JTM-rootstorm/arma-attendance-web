import { hasRole, type CurrentUser } from "../auth.js";
import { withDbTransaction } from "../db/transactions.js";
import { revertOperationPlanetProgressAwards, revertOperationXpAwards } from "../xp/operationXpAwards.js";
import type { OperationDeleteResult, OperationDeleteRow } from "./types.js";

export function canDeleteOperation(user: CurrentUser): boolean {
  return hasRole(user, ["admin"]);
}

export async function deleteOperationWithAudit(operationId: string, actor: CurrentUser): Promise<OperationDeleteResult> {
  return withDbTransaction(async (tx) => {
    const operationResult = await tx.query<OperationDeleteRow>(
      `
      SELECT id, unit_id, server_key, mission_uid, mission_name
      FROM operations
      WHERE id = $1
      FOR UPDATE
      `,
      [operationId]
    );
    const operation = operationResult.rows[0];

    if (!operation) {
      return {
        operation_id: operationId,
        operation_deleted: false,
        ingest_requests_deleted: 0,
        xp_awards_reverted_count: 0,
        xp_awards_reverted_total: 0,
        planet_progress_reverted_count: 0,
        planet_progress_reverted_total: "0.000"
      };
    }

    const xpReversal = await revertOperationXpAwards(tx, operation.id);
    const planetProgressReversal = await revertOperationPlanetProgressAwards(tx, operation.id);
    const ingestResult = await tx.query("DELETE FROM ingest_requests WHERE operation_id = $1", [operation.id]);
    await tx.query("DELETE FROM operations WHERE id = $1", [operation.id]);
    await tx.query(
      `
      INSERT INTO admin_audit_events (actor_user_id, actor_label, action, details)
      VALUES ($1, $2, 'delete_operation', $3::jsonb)
      `,
      [
        actor.id,
        actor.display_name ?? actor.id,
        JSON.stringify({
          operation_id: operation.id,
          server_key: operation.server_key,
          mission_uid: operation.mission_uid,
          mission_name: operation.mission_name,
          ingest_requests_deleted: ingestResult.rowCount ?? 0,
          xp_awards_reverted_count: xpReversal.players_updated,
          xp_awards_reverted_total: xpReversal.xp_reverted,
          planet_progress_reverted_count: planetProgressReversal.planets_updated,
          planet_progress_reverted_total: planetProgressReversal.progress_reverted
        })
      ]
    );

    return {
      operation_id: operation.id,
      operation_deleted: true,
      ingest_requests_deleted: ingestResult.rowCount ?? 0,
      xp_awards_reverted_count: xpReversal.players_updated,
      xp_awards_reverted_total: xpReversal.xp_reverted,
      planet_progress_reverted_count: planetProgressReversal.planets_updated,
      planet_progress_reverted_total: planetProgressReversal.progress_reverted
    };
  });
}
