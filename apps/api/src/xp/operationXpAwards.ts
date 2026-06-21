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

export type OperationPlanetProgressAwardSummary =
  | {
      awarded: false;
      reason:
        | "operation_failed"
        | "no_mission_name"
        | "no_matching_tier"
        | "no_planet_target"
        | "zero_progress"
        | "already_awarded";
      mission_name: string | null;
    }
  | {
      awarded: true;
      award_status: "awarded" | "already_awarded";
      mission_name: string;
      tier_id: string;
      planet_id: string;
      planet_slug: string;
      planet_name: string;
      mission_name_match: string;
      progress_percent: string;
      completion_percent_before: string;
      completion_percent_after: string;
    };

export type XpRewardTierMatchRow = {
  id: string;
  mission_name_match: string;
  xp_amount: number;
  planet_id: string | null;
  planet_slug: string | null;
  planet_name: string | null;
  planet_progress_percent: string;
};

type AwardResultRow = {
  attendee_count: number;
  players_awarded: number;
};

type RevertResultRow = {
  players_updated: number;
  xp_reverted: number;
};

type PlanetRow = {
  id: string;
  slug: string;
  name: string;
  completion_percent: string;
};

type PlanetAwardInsertRow = {
  id: string;
};

type PlanetAwardUpdateRow = {
  completion_percent: string;
};

type PlanetProgressRevertResultRow = {
  planets_updated: number;
  progress_reverted: string;
};

function normalizeMissionName(missionName: string | null): string | null {
  const normalized = missionName?.trim().replace(/\s+/g, " ") ?? "";
  return normalized.length > 0 ? normalized : null;
}

export async function findXpRewardTierForMission(
  tx: DbTransaction,
  missionName: string
): Promise<XpRewardTierMatchRow | null> {
  const tierResult = await tx.query<XpRewardTierMatchRow>(
    `
    SELECT
      xrt.id,
      xrt.mission_name_match,
      xrt.xp_amount,
      xrt.planet_id,
      p.slug AS planet_slug,
      p.name AS planet_name,
      xrt.planet_progress_percent
    FROM xp_reward_tiers xrt
    LEFT JOIN planets p ON p.id = xrt.planet_id
    WHERE position(lower(regexp_replace(btrim(xrt.mission_name_match), '\\s+', ' ', 'g')) in lower($1)) > 0
    ORDER BY
      length(regexp_replace(btrim(xrt.mission_name_match), '\\s+', ' ', 'g')) DESC,
      xrt.xp_amount DESC,
      xrt.updated_at DESC,
      xrt.id ASC
    LIMIT 1
    `,
    [missionName]
  );

  return tierResult.rows[0] ?? null;
}

export async function awardOperationXp(
  tx: DbTransaction,
  input: {
    operationId: string;
    missionName: string | null;
    tier?: XpRewardTierMatchRow | null;
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

  const tier = input.tier === undefined ? await findXpRewardTierForMission(tx, missionName) : input.tier;

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

export async function awardOperationPlanetProgress(
  tx: DbTransaction,
  input: {
    operationId: string;
    missionName: string | null;
    tier?: XpRewardTierMatchRow | null;
  }
): Promise<OperationPlanetProgressAwardSummary> {
  const missionName = normalizeMissionName(input.missionName);

  if (!missionName) {
    return {
      awarded: false,
      reason: "no_mission_name",
      mission_name: null
    };
  }

  const tier = input.tier === undefined ? await findXpRewardTierForMission(tx, missionName) : input.tier;

  if (!tier) {
    return {
      awarded: false,
      reason: "no_matching_tier",
      mission_name: missionName
    };
  }

  if (!tier.planet_id || !tier.planet_slug || !tier.planet_name) {
    return {
      awarded: false,
      reason: "no_planet_target",
      mission_name: missionName
    };
  }

  const progressPercent = Number(tier.planet_progress_percent);

  if (!Number.isFinite(progressPercent) || progressPercent <= 0) {
    return {
      awarded: false,
      reason: "zero_progress",
      mission_name: missionName
    };
  }

  const planetResult = await tx.query<PlanetRow>(
    `
    SELECT id, slug, name, completion_percent::text
    FROM planets
    WHERE id = $1
    FOR UPDATE
    `,
    [tier.planet_id]
  );
  const planet = planetResult.rows[0];

  if (!planet) {
    return {
      awarded: false,
      reason: "no_planet_target",
      mission_name: missionName
    };
  }

  const insertResult = await tx.query<PlanetAwardInsertRow>(
    `
    INSERT INTO operation_planet_progress_awards (
      operation_id,
      planet_id,
      tier_id,
      mission_name,
      mission_name_match,
      progress_percent
    )
    VALUES ($1, $2, $3, $4, $5, $6::numeric(6,3))
    ON CONFLICT (operation_id, planet_id) DO NOTHING
    RETURNING id
    `,
    [
      input.operationId,
      planet.id,
      tier.id,
      missionName,
      tier.mission_name_match,
      progressPercent.toFixed(3)
    ]
  );

  if (!insertResult.rows[0]) {
    return {
      awarded: true,
      award_status: "already_awarded",
      mission_name: missionName,
      tier_id: tier.id,
      planet_id: planet.id,
      planet_slug: planet.slug,
      planet_name: planet.name,
      mission_name_match: tier.mission_name_match,
      progress_percent: progressPercent.toFixed(3),
      completion_percent_before: Number(planet.completion_percent).toFixed(3),
      completion_percent_after: Number(planet.completion_percent).toFixed(3)
    };
  }

  const updateResult = await tx.query<PlanetAwardUpdateRow>(
    `
    UPDATE planets
    SET
      completion_percent = least(100.000, completion_percent + $2::numeric(6,3))::numeric(6,3),
      updated_at = now()
    WHERE id = $1
    RETURNING completion_percent::text
    `,
    [planet.id, progressPercent.toFixed(3)]
  );
  const updatedPlanet = updateResult.rows[0];

  if (!updatedPlanet) {
    throw new Error("Planet progress update returned no rows.");
  }

  return {
    awarded: true,
    award_status: "awarded",
    mission_name: missionName,
    tier_id: tier.id,
    planet_id: planet.id,
    planet_slug: planet.slug,
    planet_name: planet.name,
    mission_name_match: tier.mission_name_match,
    progress_percent: progressPercent.toFixed(3),
    completion_percent_before: Number(planet.completion_percent).toFixed(3),
    completion_percent_after: Number(updatedPlanet.completion_percent).toFixed(3)
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

export async function revertOperationPlanetProgressAwards(
  tx: DbTransaction,
  operationId: string
): Promise<{
  planets_updated: number;
  progress_reverted: string;
}> {
  const result = await tx.query<PlanetProgressRevertResultRow>(
    `
    WITH award_totals AS (
      SELECT
        planet_id,
        SUM(progress_percent)::numeric(6,3) AS progress_percent
      FROM operation_planet_progress_awards
      WHERE operation_id = $1
      GROUP BY planet_id
    ),
    updated_planets AS (
      UPDATE planets p
      SET
        completion_percent = greatest(0.000, p.completion_percent - award_totals.progress_percent)::numeric(6,3),
        updated_at = now()
      FROM award_totals
      WHERE p.id = award_totals.planet_id
      RETURNING award_totals.progress_percent
    )
    SELECT
      COUNT(*)::int AS planets_updated,
      COALESCE(SUM(progress_percent), 0)::numeric(6,3)::text AS progress_reverted
    FROM updated_planets
    `,
    [operationId]
  );

  return result.rows[0] ?? { planets_updated: 0, progress_reverted: "0.000" };
}
