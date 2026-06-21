import { getDefaultUnitId, getUnitIdForServerKey } from "../auth/units.js";
import { type DbTransaction, withDbTransaction } from "../db/transactions.js";
import { persistOperationAttendance } from "../normalization/operationAttendance.js";
import { insertPrimaryOperationUnit, syncOperationUnitsForParticipants } from "../normalization/operationUnits.js";
import { awardOperationPlanetProgress, awardOperationXp, findXpRewardTierForMission } from "../xp/operationXpAwards.js";
import { getMissionField, type OperationFinishBody, type OperationStartBody } from "../routes/operations/schemas.js";
import { getExistingIngestResponse, insertIngestRequest, insertOperationPayload, replayResponse } from "./ingestRequests.js";
import { OperationRouteError, type OperationIngestResponse, type OperationOutcome, type OperationStatus } from "./types.js";

export async function startOperationIngest(payload: OperationStartBody): Promise<OperationIngestResponse | unknown> {
  return withDbTransaction(async (tx) => {
    const existingResponse = await getExistingIngestResponse(tx, payload.request_id);

    if (existingResponse) {
      return replayResponse(existingResponse);
    }

    const unitId = (await getUnitIdForServerKey(payload.server_key)) ?? (await getDefaultUnitId());
    const operationResult = await tx.query<{
      id: string;
      status: OperationStatus;
    }>(
      `
      INSERT INTO operations (
        server_key,
        unit_id,
        mission_uid,
        mission_name,
        world_name,
        raw_start_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING id, status
      `,
      [
        payload.server_key,
        unitId,
        getMissionField(payload.mission, "mission_uid"),
        getMissionField(payload.mission, "mission_name"),
        getMissionField(payload.mission, "world_name"),
        JSON.stringify(payload)
      ]
    );

    const operation = operationResult.rows[0];

    if (!operation) {
      throw new Error("Operation start insert returned no rows.");
    }

    await insertOperationPayload(tx, operation.id, payload.request_id, "start", payload);
    await insertPrimaryOperationUnit(tx, operation.id, "server_key");
    const normalized = await persistOperationAttendance(tx, operation.id, "start", payload);

    const response: OperationIngestResponse = {
      ok: true,
      operation_id: operation.id,
      status: operation.status,
      accepted: true,
      idempotent: false,
      normalized
    };

    await insertIngestRequest(tx, payload.request_id, operation.id, "/v1/operations/start", payload, response);

    return response;
  });
}

export async function finishOperationIngest(
  operationId: string,
  payload: OperationFinishBody
): Promise<OperationIngestResponse | unknown> {
  return withDbTransaction(async (tx) => finishOperationIngestInTransaction(tx, operationId, payload));
}

function statusForFinishOutcome(outcome: OperationOutcome): Extract<OperationStatus, "finished" | "failed"> {
  return outcome === "failed" ? "failed" : "finished";
}

async function finishOperationIngestInTransaction(
  tx: DbTransaction,
  operationId: string,
  payload: OperationFinishBody
): Promise<OperationIngestResponse | unknown> {
  const existingResponse = await getExistingIngestResponse(tx, payload.request_id);

  if (existingResponse) {
    return replayResponse(existingResponse);
  }

  const existingOperationResult = await tx.query<{
    id: string;
    server_key: string;
    status: OperationStatus;
  }>(
    `
    SELECT id, server_key, status
    FROM operations
    WHERE id = $1
    FOR UPDATE
    `,
    [operationId]
  );

  const existingOperation = existingOperationResult.rows[0];

  if (!existingOperation) {
    throw new OperationRouteError(404, "operation_not_found", "Operation was not found.");
  }

  if (existingOperation.server_key !== payload.server_key) {
    throw new OperationRouteError(409, "server_key_mismatch", "Server key did not match operation.");
  }

  const finishStatus = statusForFinishOutcome(payload.outcome);
  const updateResult = await tx.query<{
    id: string;
    status: OperationStatus;
    mission_name: string | null;
  }>(
    `
    UPDATE operations
    SET
      status = $2,
      ended_at = COALESCE(ended_at, now()),
      mission_uid = COALESCE(mission_uid, $3),
      mission_name = COALESCE(mission_name, $4),
      world_name = COALESCE(world_name, $5),
      raw_end_payload = $6::jsonb,
      updated_at = now()
    WHERE id = $1
    RETURNING id, status, mission_name
    `,
    [
      operationId,
      finishStatus,
      getMissionField(payload.mission, "mission_uid"),
      getMissionField(payload.mission, "mission_name"),
      getMissionField(payload.mission, "world_name"),
      JSON.stringify(payload)
    ]
  );

  const updatedOperation = updateResult.rows[0];

  if (!updatedOperation) {
    throw new Error("Operation finish update returned no rows.");
  }

  await insertOperationPayload(tx, operationId, payload.request_id, "finish", payload);
  const normalized = await persistOperationAttendance(tx, operationId, "finish", payload);
  await syncOperationUnitsForParticipants(tx, operationId);
  const missionName = updatedOperation.mission_name?.trim().replace(/\s+/g, " ") ?? "";
  const tier = payload.outcome === "failed" || missionName.length === 0 ? null : await findXpRewardTierForMission(tx, missionName);
  const xpAward =
    payload.outcome === "failed"
      ? {
          awarded: false as const,
          reason: "operation_failed" as const,
          mission_name: updatedOperation.mission_name,
          players_awarded: 0 as const
        }
      : await awardOperationXp(tx, {
          operationId,
          missionName: updatedOperation.mission_name,
          tier
        });
  const planetProgressAward =
    payload.outcome === "failed"
      ? {
          awarded: false as const,
          reason: "operation_failed" as const,
          mission_name: updatedOperation.mission_name
        }
      : await awardOperationPlanetProgress(tx, {
          operationId,
          missionName: updatedOperation.mission_name,
          tier
        });

  const response: OperationIngestResponse = {
    ok: true,
    operation_id: updatedOperation.id,
    status: updatedOperation.status,
    outcome: payload.outcome,
    accepted: true,
    idempotent: false,
    normalized,
    xp_award: xpAward,
    planet_progress_award: planetProgressAward
  };

  await insertIngestRequest(
    tx,
    payload.request_id,
    operationId,
    "/v1/operations/:operation_id/finish",
    payload,
    response
  );

  return response;
}
