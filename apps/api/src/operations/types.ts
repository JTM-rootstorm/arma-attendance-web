import type { NormalizationSummary } from "../normalization/operationAttendance.js";
import type { OperationXpAwardSummary } from "../xp/operationXpAwards.js";

export type OperationStatus = "started" | "finished" | "failed" | "abandoned";
export type OperationOutcome = "success" | "failed";

export type OperationIngestResponse = {
  ok: true;
  operation_id: string;
  status: OperationStatus;
  outcome?: OperationOutcome;
  accepted: true;
  idempotent: boolean;
  normalized?: NormalizationSummary;
  xp_award?: OperationXpAwardSummary;
};

export type OperationRow = {
  id: string;
  unit_id: string | null;
  server_key: string;
  status: OperationStatus;
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  raw_start_payload: unknown;
  raw_end_payload: unknown;
};

export type OperationListRow = {
  id: string;
  unit_id: string | null;
  server_key: string;
  status: OperationStatus;
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  payload_count: number;
};

export type OperationPayloadRow = {
  id: string;
  kind: "start" | "finish";
  request_id: string;
  received_at: Date;
  payload: unknown;
};

export type OperationUnitRow = {
  id: string;
  unit_id: string | null;
};

export type OperationDeleteRow = {
  id: string;
  unit_id: string | null;
  server_key: string;
  mission_uid: string | null;
  mission_name: string | null;
};

export type OperationAttendanceRow = {
  player_uid: string;
  name_at_start: string | null;
  name_at_end: string | null;
  side_at_start: string | null;
  side_at_end: string | null;
  group_at_start: string | null;
  group_at_end: string | null;
  role_at_start: string | null;
  role_at_end: string | null;
  unit_class_at_start: string | null;
  unit_class_at_end: string | null;
  vehicle_class_at_start: string | null;
  vehicle_class_at_end: string | null;
  present_at_start: boolean;
  present_at_end: boolean;
  stats_player_uid: string | null;
  infantry_kills: number | null;
  vehicle_kills: number | null;
  player_kills: number | null;
  ai_kills: number | null;
  friendly_kills: number | null;
  deaths: number | null;
  soft_vehicle_kills: number | null;
  armor_kills: number | null;
  air_kills: number | null;
  ground_vehicle_kills: number | null;
  all_vehicle_kills: number | null;
  scoreboard_score: number | null;
};

export type OperationDeleteResult = {
  operation_id: string;
  operation_deleted: boolean;
  ingest_requests_deleted: number;
  xp_awards_reverted_count: number;
  xp_awards_reverted_total: number;
};

export class OperationRouteError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly publicMessage: string;

  public constructor(statusCode: number, code: string, publicMessage: string) {
    super(publicMessage);
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}
