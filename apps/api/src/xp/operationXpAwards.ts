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
        | "no_world_name"
        | "no_matching_tier"
        | "no_matching_planet"
        | "zero_progress"
        | "already_awarded";
      mission_name: string | null;
      world_name: string | null;
    }
  | {
      awarded: true;
      award_status: "awarded" | "already_awarded";
      mission_name: string;
      world_name: string;
      tier_id: string;
      mission_name_match: string;
      progress_percent: string;
      planets_updated: number;
      planets: Array<{
        planet_id: string;
        planet_slug: string;
        planet_name: string;
        world_name_match: string;
        completion_percent_before: string;
        completion_percent_after: string;
      }>;
    };

export type XpRewardTierMatchRow = {
  id: string;
  mission_name_match: string;
  xp_amount: number;
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
  world_name_match: string;
};

type PlanetAwardUpdateRow = {
  id: string;
  slug: string;
  name: string;
  world_name_match: string;
  completion_percent_before: string;
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

function normalizeWorldName(worldName: string | null): string | null {
  const normalized = worldName?.trim().replace(/\s+/g, " ") ?? "";
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
      xrt.planet_progress_percent
    FROM xp_reward_tiers xrt
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
    worldName: string | null;
    tier?: XpRewardTierMatchRow | null;
  }
): Promise<OperationPlanetProgressAwardSummary> {
  const missionName = normalizeMissionName(input.missionName);
  const worldName = normalizeWorldName(input.worldName);

  if (!missionName) {
    return {
      awarded: false,
      reason: "no_mission_name",
      mission_name: null,
      world_name: worldName
    };
  }

  if (!worldName) {
    return {
      awarded: false,
      reason: "no_world_name",
      mission_name: missionName,
      world_name: null
    };
  }

  const tier = input.tier === undefined ? await findXpRewardTierForMission(tx, missionName) : input.tier;

  if (!tier) {
    return {
      awarded: false,
      reason: "no_matching_tier",
      mission_name: missionName,
      world_name: worldName
    };
  }

  const progressPercent = Number(tier.planet_progress_percent);

  if (!Number.isFinite(progressPercent) || progressPercent <= 0) {
    return {
      awarded: false,
      reason: "zero_progress",
      mission_name: missionName,
      world_name: worldName
    };
  }

  const existingAwardResult = await tx.query<PlanetRow>(
    `
    SELECT p.id, p.slug, p.name, p.completion_percent::text, COALESCE(oppa.world_name_match, '') AS world_name_match
    FROM operation_planet_progress_awards oppa
    JOIN planets p ON p.id = oppa.planet_id
    WHERE oppa.operation_id = $1
    ORDER BY p.display_order ASC, p.name ASC
    `,
    [input.operationId]
  );

  if (existingAwardResult.rows.length > 0) {
    return {
      awarded: true,
      award_status: "already_awarded",
      mission_name: missionName,
      world_name: worldName,
      tier_id: tier.id,
      mission_name_match: tier.mission_name_match,
      progress_percent: progressPercent.toFixed(3),
      planets_updated: existingAwardResult.rows.length,
      planets: existingAwardResult.rows.map((planet) => ({
        planet_id: planet.id,
        planet_slug: planet.slug,
        planet_name: planet.name,
        world_name_match: planet.world_name_match,
        completion_percent_before: Number(planet.completion_percent).toFixed(3),
        completion_percent_after: Number(planet.completion_percent).toFixed(3)
      }))
    };
  }

  const updateResult = await tx.query<PlanetAwardUpdateRow>(
    `
    WITH matched_planet AS MATERIALIZED (
      SELECT
        p.id,
        p.slug,
        p.name,
        p.display_order,
        p.completion_percent,
        pwf.world_name_match
      FROM planet_world_filters pwf
      JOIN planets p ON p.id = pwf.planet_id
      WHERE p.is_active = true
        AND position(lower(regexp_replace(btrim(pwf.world_name_match), '\\s+', ' ', 'g')) in lower($6)) > 0
      ORDER BY
        length(regexp_replace(btrim(pwf.world_name_match), '\\s+', ' ', 'g')) DESC,
        p.display_order ASC,
        p.name ASC,
        p.id ASC
      LIMIT 1
      FOR UPDATE
    ),
    inserted_awards AS (
      INSERT INTO operation_planet_progress_awards (
        operation_id,
        planet_id,
        tier_id,
        mission_name,
        mission_name_match,
        world_name_match,
        progress_percent
      )
      SELECT
        $1,
        matched_planet.id,
        $2,
        $3,
        $4,
        matched_planet.world_name_match,
        $5::numeric(6,3)
      FROM matched_planet
      ON CONFLICT (operation_id, planet_id) DO NOTHING
      RETURNING planet_id
    ),
    updated_planets AS (
      UPDATE planets p
      SET
        completion_percent = least(100.000, p.completion_percent + $5::numeric(6,3))::numeric(6,3),
        updated_at = now()
      FROM matched_planet
      JOIN inserted_awards ON inserted_awards.planet_id = matched_planet.id
      WHERE p.id = matched_planet.id
      RETURNING
        p.id,
        p.slug,
        p.name,
        matched_planet.display_order,
        matched_planet.world_name_match,
        matched_planet.completion_percent::text AS completion_percent_before,
        p.completion_percent::text AS completion_percent
    )
    SELECT id, slug, name, world_name_match, completion_percent_before, completion_percent
    FROM updated_planets
    ORDER BY display_order ASC, name ASC
    `,
    [
      input.operationId,
      tier.id,
      missionName,
      tier.mission_name_match,
      progressPercent.toFixed(3),
      worldName
    ]
  );

  if (updateResult.rows.length === 0) {
    return {
      awarded: false,
      reason: "no_matching_planet",
      mission_name: missionName,
      world_name: worldName
    };
  }

  return {
    awarded: true,
    award_status: "awarded",
    mission_name: missionName,
    world_name: worldName,
    tier_id: tier.id,
    mission_name_match: tier.mission_name_match,
    progress_percent: progressPercent.toFixed(3),
    planets_updated: updateResult.rows.length,
    planets: updateResult.rows.map((planet) => ({
      planet_id: planet.id,
      planet_slug: planet.slug,
      planet_name: planet.name,
      world_name_match: planet.world_name_match,
      completion_percent_before: Number(planet.completion_percent_before).toFixed(3),
      completion_percent_after: Number(planet.completion_percent).toFixed(3)
    }))
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
