import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { config } from "../config.js";
import { queryDb } from "../db/pool.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import type {
  DiscordAttendanceRuleRow,
  DiscordEvaluationResult,
  DiscordRoleAction,
  DiscordRuleScore,
  DiscordSkippedAction
} from "./types.js";

type PlayerScoreRow = QueryResultRow & {
  player_uid: string;
  player_name: string | null;
  discord_user_id: string | null;
  discord_display_name: string | null;
  attended_count: number;
};

type AuditInsertRow = {
  id: string;
  ord: number;
};

function toNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  return typeof value === "number" ? value : Number(value);
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildEligibilityClause(rule: DiscordAttendanceRuleRow): { clause: string; values: unknown[] } {
  const where = [rule.include_started_operations ? "o.status IN ('started', 'finished')" : "o.status = 'finished'"];
  const values: unknown[] = [];

  if (rule.lookback_days !== null) {
    values.push(rule.lookback_days);
    where.push(`o.started_at >= now() - ($${values.length}::int * interval '1 day')`);
  }

  if (rule.server_key) {
    values.push(rule.server_key);
    where.push(`o.server_key = $${values.length}`);
  }

  if (rule.mission_uid_pattern) {
    values.push(rule.mission_uid_pattern);
    where.push(`o.mission_uid ILIKE $${values.length}`);
  }

  return {
    clause: where.join(" AND "),
    values
  };
}

function meetsRule(rule: DiscordAttendanceRuleRow, score: DiscordRuleScore): boolean {
  const minPercent = toNumber(rule.min_attendance_percent);

  return (
    score.attendance_points >= rule.min_attendance_points &&
    score.operation_count >= rule.min_operation_count &&
    (minPercent === null || score.attendance_percent >= minPercent)
  );
}

async function getEligibleOperationCount(rule: DiscordAttendanceRuleRow): Promise<number> {
  const eligibility = buildEligibilityClause(rule);
  const result = await queryDb<{ total: number }>(
    `
    SELECT COUNT(*)::int AS total
    FROM operations o
    WHERE ${eligibility.clause}
    `,
    eligibility.values
  );

  return result.rows[0]?.total ?? 0;
}

async function getPlayerScores(rule: DiscordAttendanceRuleRow): Promise<PlayerScoreRow[]> {
  const eligibility = buildEligibilityClause(rule);
  const attendedCondition = rule.require_present_at_end
    ? "op.present_at_end = true"
    : "(op.present_at_start = true OR op.present_at_end = true)";

  const result = await queryDb<PlayerScoreRow>(
    `
    WITH eligible_operations AS (
      SELECT o.id
      FROM operations o
      WHERE ${eligibility.clause}
    )
    SELECT
      p.player_uid,
      p.last_name AS player_name,
      pdl.discord_user_id,
      pdl.discord_display_name,
      COUNT(op.operation_id) FILTER (WHERE ${attendedCondition})::int AS attended_count
    FROM players p
    JOIN operation_players op ON op.player_uid = p.player_uid
    JOIN eligible_operations eo ON eo.id = op.operation_id
    LEFT JOIN player_discord_links pdl ON pdl.player_uid = p.player_uid
    GROUP BY p.player_uid, p.last_name, pdl.discord_user_id, pdl.discord_display_name
    ORDER BY p.last_name NULLS LAST, p.player_uid
    `,
    eligibility.values
  );

  return result.rows;
}

type RuleEvaluation = {
  actions: DiscordRoleAction[];
  skipped: DiscordSkippedAction[];
  evaluatedPlayers: string[];
};

async function evaluateDiscordRoleRule(rule: DiscordAttendanceRuleRow): Promise<RuleEvaluation> {
  const [eligibleOperationCount, playerScores] = await mapWithConcurrency(
    ["eligible_operation_count", "player_scores"] as const,
    2,
    async (task) => {
      if (task === "eligible_operation_count") {
        return getEligibleOperationCount(rule);
      }

      return getPlayerScores(rule);
    }
  );
  const eligibleCount = eligibleOperationCount as number;
  const scores = playerScores as PlayerScoreRow[];
  const actions: DiscordRoleAction[] = [];
  const skipped: DiscordSkippedAction[] = [];
  const evaluatedPlayers = new Set<string>();

  for (const player of scores) {
    evaluatedPlayers.add(player.player_uid);
    const score = {
      attendance_points: player.attended_count,
      operation_count: player.attended_count,
      attendance_percent: eligibleCount === 0 ? 0 : roundPercent((player.attended_count / eligibleCount) * 100)
    };
    const qualifies = meetsRule(rule, score);

    if (qualifies && !player.discord_user_id) {
      skipped.push({
        action: "skip",
        rule_id: rule.id,
        rule_name: rule.name,
        role_id: rule.role_id,
        role_name: rule.role_name,
        player_uid: player.player_uid,
        player_name: player.player_name,
        discord_user_id: null,
        discord_display_name: null,
        score,
        reason: `missing Discord link for rule ${rule.name}`
      });
      continue;
    }

    if (qualifies && player.discord_user_id) {
      actions.push({
        action: "grant",
        rule_id: rule.id,
        rule_name: rule.name,
        role_id: rule.role_id,
        role_name: rule.role_name,
        player_uid: player.player_uid,
        player_name: player.player_name,
        discord_user_id: player.discord_user_id,
        discord_display_name: player.discord_display_name,
        score,
        reason: `meets rule ${rule.name}`
      });
      continue;
    }

    if (!qualifies && rule.grant_mode === "grant_and_revoke_preview" && player.discord_user_id) {
      actions.push({
        action: "revoke_preview",
        rule_id: rule.id,
        rule_name: rule.name,
        role_id: rule.role_id,
        role_name: rule.role_name,
        player_uid: player.player_uid,
        player_name: player.player_name,
        discord_user_id: player.discord_user_id,
        discord_display_name: player.discord_display_name,
        score,
        reason: `does not meet rule ${rule.name}; revoke is preview-only`
      });
    }
  }

  return { actions, skipped, evaluatedPlayers: Array.from(evaluatedPlayers) };
}

async function persistAuditActions(
  guildId: string,
  evaluationId: string,
  auditActions: Array<DiscordRoleAction | DiscordSkippedAction>
): Promise<string[]> {
  if (auditActions.length === 0) {
    return [];
  }

  const payloads = auditActions.map((action, index) => ({ ...action, __audit_order: index }));
  const result = await queryDb<AuditInsertRow>(
    `
    WITH input AS (
      SELECT value AS payload, ord
      FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS item(value, ord)
    ),
    inserted AS (
      INSERT INTO discord_role_action_audits (
        guild_id,
        rule_id,
        player_uid,
        discord_user_id,
        role_id,
        action,
        status,
        reason,
        evaluation_id,
        payload
      )
      SELECT
        $1,
        (payload->>'rule_id')::uuid,
        payload->>'player_uid',
        payload->>'discord_user_id',
        payload->>'role_id',
        payload->>'action',
        CASE WHEN payload->>'action' = 'skip' THEN 'skipped' ELSE 'planned' END,
        payload->>'reason',
        $2::uuid,
        payload
      FROM input
      ORDER BY ord
      RETURNING id, payload
    ),
    ordered AS (
      SELECT id, (payload->>'__audit_order')::int AS ord
      FROM inserted
    )
    SELECT ordered.id, ordered.ord
    FROM ordered
    ORDER BY ordered.ord
    `,
    [guildId, evaluationId, JSON.stringify(payloads)]
  );

  const ids = result.rows.map((row) => row.id);

  await queryDb(
    `
    UPDATE discord_role_action_audits
    SET payload = payload - '__audit_order'
    WHERE id = ANY($1::uuid[])
    `,
    [ids]
  );

  return ids;
}

export async function evaluateDiscordRoleActions(
  guildId: string,
  persist: boolean
): Promise<DiscordEvaluationResult> {
  const evaluationId = randomUUID();
  const rulesResult = await queryDb<DiscordAttendanceRuleRow>(
    `
    SELECT
      dar.*,
      dr.name AS role_name
    FROM discord_attendance_rules dar
    JOIN discord_roles dr ON dr.guild_id = dar.guild_id AND dr.role_id = dar.role_id
    WHERE dar.guild_id = $1
      AND dar.is_enabled = true
      AND dr.is_deleted = false
    ORDER BY dar.created_at ASC, dar.id ASC
    `,
    [guildId]
  );

  const actions: DiscordRoleAction[] = [];
  const skipped: DiscordSkippedAction[] = [];
  const evaluatedPlayers = new Set<string>();

  const ruleEvaluations = await mapWithConcurrency(rulesResult.rows, config.asyncDbReadConcurrency, evaluateDiscordRoleRule);

  for (const ruleEvaluation of ruleEvaluations) {
    actions.push(...ruleEvaluation.actions);
    skipped.push(...ruleEvaluation.skipped);
    for (const playerUid of ruleEvaluation.evaluatedPlayers) {
      evaluatedPlayers.add(playerUid);
    }
  }

  if (persist) {
    const persisted = await persistAuditActions(guildId, evaluationId, [...actions, ...skipped]);

    for (const [index, auditId] of persisted.entries()) {
      if (index < actions.length) {
        actions[index]!.audit_id = auditId;
      } else {
        skipped[index - actions.length]!.audit_id = auditId;
      }
    }
  }

  return {
    evaluation_id: evaluationId,
    actions,
    skipped,
    summary: {
      rules_evaluated: rulesResult.rows.length,
      players_evaluated: evaluatedPlayers.size,
      grant_count: actions.filter((action) => action.action === "grant").length,
      skip_count: skipped.length,
      revoke_preview_count: actions.filter((action) => action.action === "revoke_preview").length
    }
  };
}
