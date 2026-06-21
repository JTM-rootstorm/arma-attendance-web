import type { DbTransaction } from "../db/transactions.js";

export type OperationXpAwardSummary =
  | {
      awarded: false;
      reason: "operation_failed" | "no_mission_name" | "no_matching_tier" | "no_attendees";
      mission_name: string | null;
      players_awarded: 0;
    }
  | {
      awarded: true;
      award_status: "awarded" | "already_awarded";
      mission_name: string;
      tier_id: string;
      mission_name_match: string;
      xp_amount: number;
      players_awarded: number;
    };

type XpRewardTierMatchRow = {
  id: string;
  mission_name_match: string;
  xp_amount: number;
};

type AwardResultRow = {
  attendee_count: number;
  players_awarded: number;
};

type RevertResultRow = {
  players_updated: number;
  xp_reverted: number;
};

function normalizeMissionName(missionName: string | null): string | null {
  const normalized = missionName?.trim().replace(/\s+/g, " ") ?? "";
  return normalized.length > 0 ? normalized : null;
}

export async function awardOperationXp(
  tx: DbTransaction,
  input: {
    operationId: string;
    missionName: string | null;
  }
): Promise<OperationXpAwardSummary> {
  const missionName = normalizeMissionName(input.missionName);

  if (!missionName) {
    return {
      awarded: false,
      reason: "no_mission_name",
      mission_name: null,
      players_awarded: 0
    };
  }

  const tierResult = await tx.query<XpRewardTierMatchRow>(
    `
    SELECT
      id,
      mission_name_match,
      xp_amount
    FROM xp_reward_tiers
    WHERE position(lower(regexp_replace(btrim(mission_name_match), '\\s+', ' ', 'g')) in lower($1)) > 0
    ORDER BY
      length(regexp_replace(btrim(mission_name_match), '\\s+', ' ', 'g')) DESC,
      xp_amount DESC,
      updated_at DESC,
      id ASC
    LIMIT 1
    `,
    [missionName]
  );
  const tier = tierResult.rows[0];

  if (!tier) {
    return {
      awarded: false,
      reason: "no_matching_tier",
      mission_name: missionName,
      players_awarded: 0
    };
  }

  const awardResult = await tx.query<AwardResultRow>(
    `
    WITH attendees AS (
      SELECT DISTINCT player_uid
      FROM operation_players
      WHERE operation_id = $1
        AND (present_at_start = true OR present_at_end = true)
    ),
    inserted_awards AS (
      INSERT INTO operation_xp_awards (
        operation_id,
        player_uid,
        tier_id,
        mission_name,
        mission_name_match,
        xp_amount
      )
      SELECT
        $1,
        attendees.player_uid,
        $2,
        $3,
        $4,
        $5
      FROM attendees
      ON CONFLICT (operation_id, player_uid) DO NOTHING
      RETURNING player_uid, xp_amount
    ),
    updated_players AS (
      UPDATE players p
      SET
        xp_total = p.xp_total + inserted_awards.xp_amount,
        updated_at = now()
      FROM inserted_awards
      WHERE p.player_uid = inserted_awards.player_uid
      RETURNING p.player_uid
    )
    SELECT
      (SELECT COUNT(*)::int FROM attendees) AS attendee_count,
      (SELECT COUNT(*)::int FROM updated_players) AS players_awarded
    `,
    [input.operationId, tier.id, missionName, tier.mission_name_match, tier.xp_amount]
  );
  const award = awardResult.rows[0] ?? { attendee_count: 0, players_awarded: 0 };

  if (award.attendee_count === 0) {
    return {
      awarded: false,
      reason: "no_attendees",
      mission_name: missionName,
      players_awarded: 0
    };
  }

  return {
    awarded: true,
    award_status: award.players_awarded > 0 ? "awarded" : "already_awarded",
    mission_name: missionName,
    tier_id: tier.id,
    mission_name_match: tier.mission_name_match,
    xp_amount: tier.xp_amount,
    players_awarded: award.players_awarded
  };
}

export async function revertOperationXpAwards(
  tx: DbTransaction,
  operationId: string
): Promise<{
  players_updated: number;
  xp_reverted: number;
}> {
  const result = await tx.query<RevertResultRow>(
    `
    WITH award_totals AS (
      SELECT
        player_uid,
        SUM(xp_amount)::int AS xp_amount
      FROM operation_xp_awards
      WHERE operation_id = $1
      GROUP BY player_uid
    ),
    updated_players AS (
      UPDATE players p
      SET
        xp_total = greatest(0, p.xp_total - award_totals.xp_amount),
        updated_at = now()
      FROM award_totals
      WHERE p.player_uid = award_totals.player_uid
      RETURNING award_totals.xp_amount
    )
    SELECT
      COUNT(*)::int AS players_updated,
      COALESCE(SUM(xp_amount), 0)::int AS xp_reverted
    FROM updated_players
    `,
    [operationId]
  );

  return result.rows[0] ?? { players_updated: 0, xp_reverted: 0 };
}
