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

export type ScoreboardStats = {
  infantry_kills: number;
  soft_vehicle_kills: number;
  armor_kills: number;
  ground_vehicle_kills?: number;
  air_kills: number;
  all_vehicle_kills?: number;
  deaths: number;
  score?: number;
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
    soft_vehicle_kills?: number;
    armor_kills?: number;
    air_kills?: number;
    ground_vehicle_kills?: number;
    all_vehicle_kills?: number;
    scoreboard_score?: number;
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
    player_uid: string | null;
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
    scoreboard_stats: ScoreboardStats | null;
  }>;
};

export type PlayersResponse = {
  ok: true;
  players: Array<{
    player_uid: string | null;
    last_name: string | null;
    first_seen_at: string;
    last_seen_at: string;
    operation_count: number | null;
  }>;
};

export type PlayerDetailResponse = {
  ok: true;
  player: {
    player_uid: string | null;
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
    scoreboard_stats?: ScoreboardStats | null;
  }>;
};

export type PlayerSummaryResponse = {
  ok: true;
  summary: {
    operation_count: number | null;
    present_at_start_count: number | null;
    present_at_end_count: number | null;
    infantry_kills: number;
    vehicle_kills: number;
    player_kills: number;
    ai_kills: number;
    friendly_kills: number;
    deaths: number;
    soft_vehicle_kills?: number;
    armor_kills?: number;
    air_kills?: number;
  };
  scoreboard_totals?: ScoreboardStats;
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

export type AuthIdentity = {
  provider: "discord" | "steam";
  provider_user_id: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type AuthUser = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  roles: Array<"owner" | "tcw_admin" | "admin" | "officer" | "viewer">;
  unit_memberships: Array<{
    unit_id: string;
    unit_key: string;
    name: string;
    role: "member" | "officer" | "admin" | "tcw_admin";
  }>;
  units?: Array<{
    unit_id: string;
    slug: string;
    name: string;
    roles: Array<"member" | "officer" | "admin" | "tcw_admin">;
  }>;
  self_player_uids?: string[];
  is_owner?: boolean;
  is_tcw_admin?: boolean;
  capabilities?: {
    can_view_global_admin: boolean;
    can_view_sensitive_identifiers: boolean;
    can_export: boolean;
    can_manage_api_tokens: boolean;
  };
  identities: AuthIdentity[];
};

export type MeResponse = {
  ok: true;
  user: AuthUser;
};

export type AdminUser = AuthUser & {
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

export type AdminUsersResponse = {
  ok: true;
  users: AdminUser[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
};

export type MyPlayerResponse = {
  ok: true;
  linked_player: {
    display_name: string | null;
    rank: string | null;
    first_seen_at?: string;
    last_seen_at?: string;
  } | null;
  battalion_memberships?: Array<{
    unit_id: string;
    unit_key: string;
    name: string;
    callsign: string | null;
    rank: string | null;
    roster_name: string | null;
    roster_status: string;
  }>;
  summary?: PlayerSummaryResponse["summary"];
  scoreboard_totals?: ScoreboardStats;
  message?: string;
};

export type MyOperationsResponse = {
  ok: true;
  linked_player: {
    display_name: string | null;
    rank: string | null;
  } | null;
  operations: Array<{
    operation_id: string;
    status: OperationStatus;
    mission_name: string | null;
    world_name: string | null;
    started_at: string;
    ended_at: string | null;
    present_at_start: boolean;
    present_at_end: boolean;
  }>;
  message?: string;
};

export type MyOperationMatesResponse = {
  ok: true;
  mates: Array<{
    name: string | null;
    rank: string | null;
    role: string | null;
    side: string | null;
    group_name: string | null;
  }>;
  message?: string;
};

export type MachineTokenRecord = {
  id: string;
  name: string;
  token_kind: "api" | "bot" | "arma_server";
  token_prefix: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type MachineTokensResponse = {
  ok: true;
  tokens: MachineTokenRecord[];
  env_tokens: {
    api_token_present: boolean;
    bot_api_token_present: boolean;
    api_token_source: string;
  };
};

export type CreateMachineTokenResponse = {
  ok: true;
  token: string;
  token_record: MachineTokenRecord;
};

export type UnitRole = "member" | "officer" | "admin" | "tcw_admin";

export type BattalionSummary = {
  unit_id: string;
  unit_key: string;
  name: string;
  display_name: string;
  callsign: string | null;
  description: string | null;
  emblem_url: string | null;
  sort_order: number;
  is_active: boolean;
  member_count: number;
  unassigned_count: number;
  squad_count: number;
  my_roles: UnitRole[];
};

export type UnitsResponse = {
  ok: true;
  units: BattalionSummary[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
};

export type BattalionRank = {
  id: string;
  unit_id: string;
  rank_key: string;
  name: string;
  short_name: string | null;
  sort_order: number;
  is_active: boolean;
};

export type BattalionRosterPlayer = {
  player_uid: string | null;
  roster_name: string;
  player_name: string | null;
  rank: string | null;
  rank_id: string | null;
  rank_sort: number;
  roster_status: "active" | "reserve" | "loa" | "inactive";
  notes: string | null;
  squad_id: string | null;
  billet: "unassigned" | "squad_lead" | "fireteam_lead" | "trooper";
  sort_order: number;
};

export type BattalionSquadNode = {
  id: string;
  parent_squad_id: string | null;
  squad_key: string;
  name: string;
  squad_type: "company" | "platoon" | "squad" | "fireteam" | "detachment";
  hierarchy_mode: "flat" | "tree";
  sort_order: number;
  leader: BattalionRosterPlayer | null;
  members: BattalionRosterPlayer[];
  children: BattalionSquadNode[];
};

export type BattalionRosterResponse = {
  ok: true;
  unit: {
    id: string;
    unit_key: string;
    name: string;
    display_name: string | null;
    callsign: string | null;
    description: string | null;
    emblem_url: string | null;
    sort_order: number;
    is_active: boolean;
  };
  ranks: BattalionRank[];
  unassigned: BattalionRosterPlayer[];
  squads: BattalionSquadNode[];
};

export type BattalionPlayerCandidatesResponse = {
  ok: true;
  players: Array<{
    player_uid: string;
    last_name: string | null;
    last_seen_at: string;
    operation_count: number;
  }>;
};

export type UnitLeaderboardResponse = {
  ok: true;
  leaderboard: Array<{
    rank: number;
    unit_id: string | null;
    unit_key: string | null;
    name: string;
    member_count: number;
    operation_count: number;
    total_kills: number;
    infantry_kills: number;
    soft_vehicle_kills: number;
    armor_kills: number;
    air_kills: number;
    deaths: number;
  }>;
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
};

export type ViewName =
  | "me"
  | "battalion"
  | "leaderboard"
  | "dashboard"
  | "operations"
  | "players"
  | "discord"
  | "admin"
  | "system";
