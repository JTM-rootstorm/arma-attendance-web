import { hasRole, type CurrentUser } from "../auth.js";
import { canSeeSensitiveIds, getReadableUnitFilter, type AnonymousAuthContext, type AuthContext } from "../auth/authorization.js";
import { getLinkedPlayerUid } from "../auth/operationAccess.js";
import { queryDb } from "../db/pool.js";
import { redactOperationListItem } from "../privacy/redaction.js";
import type {
  OperationAttendanceRow,
  OperationListRow,
  OperationPayloadRow,
  OperationRow,
  OperationUnitRow
} from "./types.js";
import type { OperationListQuery } from "../routes/operations/schemas.js";

export function canSeeOperationAttendancePlayerIds(user: CurrentUser | null): boolean {
  return user === null || hasRole(user, ["admin"]);
}

export async function listOperations(
  auth: AuthContext | AnonymousAuthContext,
  parsedQuery: OperationListQuery
): Promise<{
  ok: true;
  operations: Array<Record<string, unknown>>;
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
}> {
  const query = {
    ...parsedQuery,
    limit: auth.kind === "anonymous" ? Math.min(parsedQuery.limit, 20) : parsedQuery.limit,
    offset: auth.kind === "anonymous" ? 0 : parsedQuery.offset,
    server_key: auth.kind === "anonymous" ? undefined : parsedQuery.server_key,
    mission_uid: auth.kind === "anonymous" ? undefined : parsedQuery.mission_uid
  };
  const where: string[] = [];
  const values: unknown[] = [];
  if (auth.user && !hasRole(auth.user, ["admin"])) {
    const playerUid = await getLinkedPlayerUid(auth.user);

    if (!playerUid) {
      return {
        ok: true,
        operations: [],
        pagination: {
          limit: query.limit,
          offset: query.offset,
          count: 0
        }
      };
    }

    values.push(playerUid);
    where.push(`EXISTS (
      SELECT 1
      FROM operation_players self_op
      WHERE self_op.operation_id = o.id
        AND self_op.player_uid = $${values.length}
    )`);
  } else {
    const unitFilter = await getReadableUnitFilter(auth.user);

    if (!unitFilter.all) {
      values.push(unitFilter.unitIds);
      where.push(`o.unit_id = ANY($${values.length}::uuid[])`);
    }
  }

  if (query.server_key) {
    values.push(query.server_key);
    where.push(`o.server_key = $${values.length}`);
  }

  if (query.status) {
    values.push(query.status);
    where.push(`o.status = $${values.length}`);
  }

  if (query.mission_uid) {
    values.push(query.mission_uid);
    where.push(`o.mission_uid = $${values.length}`);
  }

  values.push(query.limit);
  const limitParam = values.length;
  values.push(query.offset);
  const offsetParam = values.length;

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const operationsResult = await queryDb<OperationListRow>(
    `
    SELECT
      o.id,
      o.unit_id,
      o.server_key,
      o.status,
      o.mission_uid,
      o.mission_name,
      o.world_name,
      o.started_at,
      o.ended_at,
      COUNT(op.id)::int AS payload_count
    FROM operations o
    LEFT JOIN operation_payloads op ON op.operation_id = o.id
    ${whereClause}
    GROUP BY o.id
    ORDER BY o.started_at DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
    `,
    values
  );

  return {
    ok: true,
    operations: operationsResult.rows.map((row) => {
      const redacted = redactOperationListItem(row, canSeeSensitiveIds(auth.user, auth.machineTokenKind));

      if (auth.kind !== "anonymous") {
        return redacted;
      }

      return {
        ...redacted,
        id: null,
        unit_id: null,
        payload_count: undefined
      };
    }),
    pagination: {
      limit: query.limit,
      offset: query.offset,
      count: operationsResult.rows.length
    }
  };
}

export async function getOperationUnit(operationId: string): Promise<OperationUnitRow | null> {
  const operationResult = await queryDb<OperationUnitRow>("SELECT id, unit_id FROM operations WHERE id = $1", [operationId]);
  return operationResult.rows[0] ?? null;
}

export async function getOperationPayloads(operationId: string): Promise<OperationPayloadRow[]> {
  const payloadResult = await queryDb<OperationPayloadRow>(
    `
    SELECT id, kind, request_id, received_at, payload
    FROM operation_payloads
    WHERE operation_id = $1
    ORDER BY received_at ASC
    `,
    [operationId]
  );

  return payloadResult.rows;
}

export async function getOperationAttendance(operationId: string): Promise<OperationAttendanceRow[]> {
  const attendanceResult = await queryDb<OperationAttendanceRow>(
    `
    SELECT
      op.player_uid,
      op.name_at_start,
      op.name_at_end,
      op.side_at_start,
      op.side_at_end,
      op.group_at_start,
      op.group_at_end,
      op.role_at_start,
      op.role_at_end,
      op.unit_class_at_start,
      op.unit_class_at_end,
      op.vehicle_class_at_start,
      op.vehicle_class_at_end,
      op.present_at_start,
      op.present_at_end,
      ops.player_uid AS stats_player_uid,
      ops.infantry_kills,
      ops.vehicle_kills,
      ops.player_kills,
      ops.ai_kills,
      ops.friendly_kills,
      ops.deaths,
      ops.soft_vehicle_kills,
      ops.armor_kills,
      ops.air_kills,
      ops.ground_vehicle_kills,
      ops.all_vehicle_kills,
      ops.scoreboard_score
    FROM operation_players op
    LEFT JOIN operation_player_stats ops
      ON ops.operation_id = op.operation_id
      AND ops.player_uid = op.player_uid
    WHERE op.operation_id = $1
    ORDER BY COALESCE(op.name_at_end, op.name_at_start, op.player_uid), op.player_uid
    `,
    [operationId]
  );

  return attendanceResult.rows;
}

export async function getOperationDetail(operationId: string): Promise<{
  operation: OperationRow | null;
  payloads: Array<{
    id: string;
    kind: "start" | "finish";
    request_id: string;
    received_at: Date;
  }>;
}> {
  const operationResult = await queryDb<OperationRow>(
    `
    SELECT
      id,
      unit_id,
      server_key,
      status,
      mission_uid,
      mission_name,
      world_name,
      started_at,
      ended_at,
      raw_start_payload,
      raw_end_payload
    FROM operations
    WHERE id = $1
    `,
    [operationId]
  );

  const operation = operationResult.rows[0] ?? null;

  if (!operation) {
    return { operation: null, payloads: [] };
  }

  const payloadResult = await queryDb<{
    id: string;
    kind: "start" | "finish";
    request_id: string;
    received_at: Date;
  }>(
    `
    SELECT id, kind, request_id, received_at
    FROM operation_payloads
    WHERE operation_id = $1
    ORDER BY received_at ASC
    `,
    [operation.id]
  );

  return { operation, payloads: payloadResult.rows };
}
