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

export type DiscordGuild = {
  guild_id: string;
  name: string;
  icon_url: string | null;
  bot_user_id: string | null;
  bot_present: boolean;
  last_role_sync_at: string | null;
  created_at: string;
  updated_at: string;
  role_count?: number;
  linked_player_count?: number;
  enabled_rule_count?: number;
};

export type DiscordRole = {
  guild_id: string;
  role_id: string;
  name: string;
  color: number | null;
  position: number | null;
  managed: boolean;
  assignable: boolean;
  is_deleted: boolean;
  last_seen_at: string;
  updated_at: string;
};

export type DiscordPlayerLink = {
  player_uid: string;
  player_name: string | null;
  discord_user_id: string;
  discord_username: string | null;
  discord_display_name: string | null;
  source: "manual" | "bot" | "import";
  verified_at: string | null;
  updated_at: string;
};

export type DiscordAttendanceRule = {
  id: string;
  guild_id: string;
  role_id: string;
  role_name?: string;
  name: string;
  description: string | null;
  is_enabled: boolean;
  min_attendance_points: number;
  min_operation_count: number;
  min_attendance_percent: string | number | null;
  lookback_days: number | null;
  server_key: string | null;
  mission_uid_pattern: string | null;
  require_present_at_end: boolean;
  include_started_operations: boolean;
  grant_mode: "grant_only" | "grant_and_revoke_preview";
  updated_at: string;
};

export type DiscordRuleScore = {
  attendance_points: number;
  operation_count: number;
  attendance_percent: number;
};

export type DiscordRoleAction = {
  audit_id?: string;
  action: "grant" | "revoke_preview" | "skip";
  rule_id: string;
  rule_name: string;
  role_id: string;
  role_name: string;
  player_uid: string;
  player_name: string | null;
  discord_user_id: string | null;
  discord_display_name: string | null;
  score: DiscordRuleScore;
  reason: string;
};

export type DiscordRoleAudit = {
  id: string;
  guild_id: string;
  rule_id: string;
  player_uid: string | null;
  discord_user_id: string | null;
  role_id: string;
  action: "grant" | "revoke_preview" | "skip";
  status: "planned" | "reported_success" | "reported_failure" | "skipped";
  reason: string;
  evaluation_id: string;
  error_message: string | null;
  created_at: string;
  reported_at: string | null;
};

export type DiscordGuildsResponse = {
  ok: true;
  guilds: DiscordGuild[];
};

export type DiscordRolesResponse = {
  ok: true;
  roles: DiscordRole[];
};

export type DiscordPlayerLinksResponse = {
  ok: true;
  links: DiscordPlayerLink[];
};

export type DiscordRulesResponse = {
  ok: true;
  rules: DiscordAttendanceRule[];
};

export type DiscordRoleActionsResponse = {
  ok: true;
  guild_id: string;
  evaluation_id: string;
  dry_run: boolean;
  actions: DiscordRoleAction[];
  skipped: DiscordRoleAction[];
  summary: {
    rules_evaluated: number;
    players_evaluated: number;
    grant_count: number;
    skip_count: number;
    revoke_preview_count: number;
  };
};

export type DiscordAuditsResponse = {
  ok: true;
  audits: DiscordRoleAudit[];
};

export type ViewName = "dashboard" | "operations" | "players" | "discord";
