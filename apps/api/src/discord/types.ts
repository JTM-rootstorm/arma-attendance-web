export type DiscordAttendanceRuleRow = {
  id: string;
  guild_id: string;
  role_id: string;
  role_name: string;
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
};

export type DiscordRoleAction = {
  audit_id?: string;
  action: "grant" | "revoke_preview";
  rule_id: string;
  rule_name: string;
  role_id: string;
  role_name: string;
  player_uid: string;
  player_name: string | null;
  discord_user_id: string;
  discord_display_name: string | null;
  score: DiscordRuleScore;
  reason: string;
};

export type DiscordSkippedAction = {
  audit_id?: string;
  action: "skip";
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

export type DiscordRuleScore = {
  attendance_points: number;
  operation_count: number;
  attendance_percent: number;
};

export type DiscordEvaluationResult = {
  evaluation_id: string;
  actions: DiscordRoleAction[];
  skipped: DiscordSkippedAction[];
  summary: {
    rules_evaluated: number;
    players_evaluated: number;
    grant_count: number;
    skip_count: number;
    revoke_preview_count: number;
  };
};
