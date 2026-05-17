export type ApiError = {
  code: string;
  message: string;
};

export type ApiResult<T> =
  | {
      status: "idle" | "loading";
      data: null;
      error: null;
    }
  | {
      status: "ready";
      data: T;
      error: null;
    }
  | {
      status: "error";
      data: null;
      error: string;
      errorCode?: string;
    };

export type HealthResponse = {
  ok: boolean;
  service: string;
  version: string;
  time: string;
};

export type DbHealthResponse = {
  ok: boolean;
  database: {
    connected: boolean;
    current_database: string;
    server_time: string;
  };
};

export type OperationStatus = "started" | "finished" | "abandoned";

export type OperationListItem = {
  id: string;
  server_key: string;
  status: OperationStatus;
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: string;
  ended_at: string | null;
  payload_count?: number;
  attendance_count?: number;
};

export type DashboardSummaryResponse = {
  ok: true;
  summary: {
    operations_total: number;
    operations_started: number;
    operations_finished: number;
    players_total: number;
    attendance_rows_total: number;
    stats_rows_total: number;
    last_operation_at: string | null;
  };
  recent_operations: OperationListItem[];
  top_players_by_attendance: Array<{
    player_uid: string;
    last_name: string | null;
    operation_count: number;
  }>;
  top_players_by_ai_kills: Array<{
    player_uid: string;
    last_name: string | null;
    ai_kills: number;
  }>;
};

export type OperationsResponse = {
  ok: true;
  operations: OperationListItem[];
};

export type OperationDetailResponse = {
  ok: true;
  operation: OperationListItem & {
    raw_start_payload: unknown;
    raw_end_payload: unknown;
  };
  payloads: Array<{
    id: string;
    kind: "start" | "finish";
    request_id: string;
    received_at: string;
  }>;
};

export type OperationSummaryResponse = {
  ok: true;
  attendance: {
    present_at_start: number;
    present_at_end: number;
    start_only: number;
    end_only: number;
    both_start_and_end: number;
  };
  stats: {
    infantry_kills: number;
    vehicle_kills: number;
    player_kills: number;
    ai_kills: number;
    friendly_kills: number;
    deaths: number;
  };
  payloads: {
    total: number;
    start: number;
    finish: number;
  };
};

export type OperationAttendanceResponse = {
  ok: true;
  attendance: Array<{
    player_uid: string;
    name_at_start: string | null;
    name_at_end: string | null;
    side_at_start: string | null;
    side_at_end: string | null;
    group_at_start: string | null;
    group_at_end: string | null;
    role_at_start: string | null;
    role_at_end: string | null;
    present_at_start: boolean;
    present_at_end: boolean;
    stats: OperationSummaryResponse["stats"] | null;
  }>;
};

export type PlayersResponse = {
  ok: true;
  players: Array<{
    player_uid: string;
    last_name: string | null;
    first_seen_at: string;
    last_seen_at: string;
    operation_count: number;
  }>;
};

export type PlayerDetailResponse = {
  ok: true;
  player: {
    player_uid: string;
    last_name: string | null;
    first_seen_at: string;
    last_seen_at: string;
  };
  recent_operations: Array<{
    operation_id: string;
    server_key: string;
    status: OperationStatus;
    mission_uid: string | null;
    mission_name: string | null;
    world_name: string | null;
    started_at: string;
    ended_at: string | null;
    present_at_start: boolean;
    present_at_end: boolean;
    stats: OperationSummaryResponse["stats"] | null;
  }>;
};

export type PlayerSummaryResponse = {
  ok: true;
  summary: {
    operation_count: number;
    present_at_start_count: number;
    present_at_end_count: number;
    infantry_kills: number;
    vehicle_kills: number;
    player_kills: number;
    ai_kills: number;
    friendly_kills: number;
    deaths: number;
  };
  recent_operations: Array<{
    operation_id: string;
    server_key: string;
    status: OperationStatus;
    mission_name: string | null;
    started_at: string;
    ended_at: string | null;
    present_at_start: boolean;
    present_at_end: boolean;
  }>;
};

export type DataQualityResponse = {
  ok: true;
  checks: Record<string, unknown[]>;
};

export type ViewName = "dashboard" | "operations" | "players";
