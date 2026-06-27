import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { canSeeSensitiveIds, getOptionalAuthContext } from "../auth/authorization.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";

const unitLeaderboardQuerySchema = z.object({
  unit_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  lookback_days: z.coerce.number().int().min(1).max(3650).optional(),
  min_operations: z.coerce.number().int().min(0).default(0),
  metric: z.enum(["total_kills"]).default("total_kills")
});

const publicPlayerLeaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(20)
});

type UnitLeaderboardRow = {
  rank: number;
  unit_id: string;
  unit_key: string;
  name: string;
  member_count: number;
  operation_count: number;
  infantry_kills: number;
  soft_vehicle_kills: number;
  armor_kills: number;
  air_kills: number;
  deaths: number;
  total_kills: number;
};

type UnitLeaderboardQuery = z.infer<typeof unitLeaderboardQuerySchema>;
type PublicPlayerLeaderboardQuery = z.infer<typeof publicPlayerLeaderboardQuerySchema>;

type UnitLeaderboardPayload = {
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
  pagination: { limit: number; offset: number; count: number };
  empty_reason?: "filters_excluded_all_rows" | "no_units_or_no_operations";
};

type PlayerLeaderboardRow = {
  rank: number;
  player_uid: string;
  name: string | null;
  operation_count: number;
  infantry_kills: number;
  soft_vehicle_kills: number;
  armor_kills: number;
  air_kills: number;
  deaths: number;
  total_kills: number;
};

type PublicPlayerLeaderboardPayload = {
  ok: true;
  leaderboard: Array<{
    rank: number;
    player_uid: null;
    name: string;
    operation_count: number;
    total_kills: number;
    infantry_kills: number;
    soft_vehicle_kills: number;
    armor_kills: number;
    air_kills: number;
    deaths: number;
  }>;
  pagination: { limit: number; offset: 0; count: number };
  empty_reason?: "no_scored_players";
};

function sendValidationFailed(reply: FastifyReply) {
  return reply.code(400).send({
    ok: false,
    error: {
      code: "validation_failed",
      message: "Request did not match expected shape."
    }
  });
}

function sendDatabaseUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: {
      code: "database_unavailable",
      message: "Database is not available."
    }
  });
}

function getEmptyReason(query: UnitLeaderboardQuery): NonNullable<UnitLeaderboardPayload["empty_reason"]> {
  if (query.unit_id || query.lookback_days || query.min_operations > 0) {
    return "filters_excluded_all_rows";
  }

  return "no_units_or_no_operations";
}

async function getUnitLeaderboardPayload(query: UnitLeaderboardQuery, revealSensitive: boolean): Promise<UnitLeaderboardPayload> {
  const values: unknown[] = [];
  const filters = ["u.is_active = true", "u.deleted_at IS NULL"];
  const operationFilters: string[] = [];

  if (query.unit_id) {
    values.push(query.unit_id);
    filters.push(`u.id = $${values.length}`);
  }

  if (query.lookback_days) {
    values.push(query.lookback_days);
    operationFilters.push(`o.started_at >= now() - ($${values.length}::int * interval '1 day')`);
  }

  const operationWhereClause = operationFilters.length > 0 ? `AND ${operationFilters.join(" AND ")}` : "";

  values.push(query.min_operations);
  const minOperationsParam = values.length;
  values.push(query.limit);
  const limitParam = values.length;
  values.push(query.offset);
  const offsetParam = values.length;

  const result = await queryDb<UnitLeaderboardRow>(
    `
    WITH active_units AS (
      SELECT
        u.id AS unit_id,
        u.unit_key,
        COALESCE(u.display_name, u.name) AS name
      FROM units u
      WHERE ${filters.join(" AND ")}
    ),
    active_unit_players AS (
      SELECT DISTINCT
        au.unit_id,
        COALESCE(
          CASE
            WHEN pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
            ELSE NULL
          END,
          up.player_uid
        ) AS player_uid
      FROM active_units au
      JOIN unit_players up
        ON up.unit_id = au.unit_id
      LEFT JOIN player_discord_links pdl
        ON up.player_uid = ('discord:' || pdl.discord_user_id)
      WHERE up.is_active = true
        AND up.roster_status <> 'inactive'
    ),
    eligible_unit_operations AS (
      SELECT
        au.unit_id,
        opu.operation_id,
        COALESCE(
          CASE
            WHEN pdl.player_uid IS NOT NULL AND pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
            ELSE NULL
          END,
          opu.player_uid
        ) AS canonical_player_uid
      FROM active_units au
      JOIN operation_player_units opu ON opu.unit_id = au.unit_id
      LEFT JOIN player_discord_links pdl
        ON opu.player_uid = ('discord:' || pdl.discord_user_id)
      JOIN operations o
        ON o.id = opu.operation_id
        AND o.status = 'finished'
        ${operationWhereClause}
    ),
    normalized_stats AS (
      SELECT
        COALESCE(
          CASE
            WHEN pdl.player_uid IS NOT NULL AND pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
            ELSE NULL
          END,
          ops.player_uid
        ) AS canonical_player_uid,
        ops.operation_id,
        ops.infantry_kills,
        ops.soft_vehicle_kills,
        ops.armor_kills,
        ops.air_kills,
        ops.deaths
      FROM operation_player_stats ops
      JOIN operations o
        ON o.id = ops.operation_id
        AND o.status = 'finished'
      LEFT JOIN player_discord_links pdl
        ON ops.player_uid = ('discord:' || pdl.discord_user_id)
    ),
    per_operation_stats AS (
      SELECT
        canonical_player_uid,
        operation_id,
        SUM(infantry_kills)::int AS infantry_kills,
        SUM(soft_vehicle_kills)::int AS soft_vehicle_kills,
        SUM(armor_kills)::int AS armor_kills,
        SUM(air_kills)::int AS air_kills,
        SUM(deaths)::int AS deaths
      FROM normalized_stats
      GROUP BY canonical_player_uid, operation_id
    ),
    member_counts AS (
      SELECT
        unit_id,
        COUNT(DISTINCT player_uid)::int AS member_count
      FROM active_unit_players
      GROUP BY unit_id
    ),
    unit_operation_counts AS (
      SELECT
        unit_id,
        COUNT(DISTINCT operation_id)::int AS operation_count
      FROM eligible_unit_operations
      GROUP BY unit_id
    ),
    unit_stats AS (
      SELECT
        euo.unit_id,
        COALESCE(SUM(ops.infantry_kills), 0)::int AS infantry_kills,
        COALESCE(SUM(ops.soft_vehicle_kills), 0)::int AS soft_vehicle_kills,
        COALESCE(SUM(ops.armor_kills), 0)::int AS armor_kills,
        COALESCE(SUM(ops.air_kills), 0)::int AS air_kills,
        COALESCE(SUM(ops.deaths), 0)::int AS deaths
      FROM eligible_unit_operations euo
      JOIN per_operation_stats ops
        ON ops.operation_id = euo.operation_id
        AND ops.canonical_player_uid = euo.canonical_player_uid
      GROUP BY euo.unit_id
    ),
    totals AS (
      SELECT
        au.unit_id,
        au.unit_key,
        au.name,
        COALESCE(mc.member_count, 0)::int AS member_count,
        COALESCE(uoc.operation_count, 0)::int AS operation_count,
        COALESCE(us.infantry_kills, 0)::int AS infantry_kills,
        COALESCE(us.soft_vehicle_kills, 0)::int AS soft_vehicle_kills,
        COALESCE(us.armor_kills, 0)::int AS armor_kills,
        COALESCE(us.air_kills, 0)::int AS air_kills,
        COALESCE(us.deaths, 0)::int AS deaths
      FROM active_units au
      LEFT JOIN member_counts mc ON mc.unit_id = au.unit_id
      LEFT JOIN unit_operation_counts uoc ON uoc.unit_id = au.unit_id
      LEFT JOIN unit_stats us ON us.unit_id = au.unit_id
    ),
    ranked AS (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY
            (infantry_kills + soft_vehicle_kills + armor_kills + air_kills) DESC,
            name ASC
        )::int AS rank,
        *,
        (infantry_kills + soft_vehicle_kills + armor_kills + air_kills)::int AS total_kills
      FROM totals
      WHERE operation_count >= $${minOperationsParam}
    )
    SELECT *
    FROM ranked
    ORDER BY rank ASC
    LIMIT $${limitParam} OFFSET $${offsetParam}
    `,
    values
  );

  const payload: UnitLeaderboardPayload = {
    ok: true,
    leaderboard: result.rows.map((row) => ({
      rank: row.rank,
      unit_id: revealSensitive ? row.unit_id : null,
      unit_key: revealSensitive ? row.unit_key : null,
      name: row.name,
      member_count: row.member_count,
      operation_count: row.operation_count,
      total_kills: row.total_kills,
      infantry_kills: row.infantry_kills,
      soft_vehicle_kills: row.soft_vehicle_kills,
      armor_kills: row.armor_kills,
      air_kills: row.air_kills,
      deaths: row.deaths
    })),
    pagination: { limit: query.limit, offset: query.offset, count: result.rows.length }
  };

  if (payload.leaderboard.length === 0) {
    payload.empty_reason = getEmptyReason(query);
  }

  return payload;
}

async function getPublicPlayerLeaderboardPayload(query: PublicPlayerLeaderboardQuery): Promise<PublicPlayerLeaderboardPayload> {
  const result = await queryDb<PlayerLeaderboardRow>(
    `
    WITH normalized_stats AS (
      SELECT
        COALESCE(
          CASE
            WHEN pdl.player_uid IS NOT NULL AND pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
            ELSE NULL
          END,
          ops.player_uid
        ) AS canonical_player_uid,
        ops.operation_id,
        ops.infantry_kills,
        ops.soft_vehicle_kills,
        ops.armor_kills,
        ops.air_kills,
        ops.deaths
      FROM operation_player_stats ops
      JOIN operations o
        ON o.id = ops.operation_id
        AND o.status = 'finished'
      LEFT JOIN player_discord_links pdl
        ON ops.player_uid = ('discord:' || pdl.discord_user_id)
    ),
    per_operation_player AS (
      SELECT
        canonical_player_uid,
        operation_id,
        SUM(infantry_kills)::int AS infantry_kills,
        SUM(soft_vehicle_kills)::int AS soft_vehicle_kills,
        SUM(armor_kills)::int AS armor_kills,
        SUM(air_kills)::int AS air_kills,
        SUM(deaths)::int AS deaths
      FROM normalized_stats
      GROUP BY canonical_player_uid, operation_id
    ),
    player_totals AS (
      SELECT
        p.player_uid,
        p.last_name AS name,
        COUNT(DISTINCT pop.operation_id)::int AS operation_count,
        COALESCE(SUM(pop.infantry_kills), 0)::int AS infantry_kills,
        COALESCE(SUM(pop.soft_vehicle_kills), 0)::int AS soft_vehicle_kills,
        COALESCE(SUM(pop.armor_kills), 0)::int AS armor_kills,
        COALESCE(SUM(pop.air_kills), 0)::int AS air_kills,
        COALESCE(SUM(pop.deaths), 0)::int AS deaths
      FROM per_operation_player pop
      JOIN players p ON p.player_uid = pop.canonical_player_uid
      WHERE p.deleted_at IS NULL
      GROUP BY p.player_uid, p.last_name, p.last_seen_at
    ),
    ranked AS (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY
            (infantry_kills + soft_vehicle_kills + armor_kills + air_kills) DESC,
            operation_count DESC,
            deaths ASC,
            COALESCE(name, player_uid) ASC,
            player_uid ASC
        )::int AS rank,
        *,
        (infantry_kills + soft_vehicle_kills + armor_kills + air_kills)::int AS total_kills
      FROM player_totals
    )
    SELECT *
    FROM ranked
    ORDER BY rank ASC
    LIMIT $1
    `,
    [query.limit]
  );

  const payload: PublicPlayerLeaderboardPayload = {
    ok: true,
    leaderboard: result.rows.map((row) => ({
      rank: row.rank,
      player_uid: null,
      name: row.name && row.name.trim().length > 0 ? row.name : "Unknown Player",
      operation_count: row.operation_count,
      total_kills: row.total_kills,
      infantry_kills: row.infantry_kills,
      soft_vehicle_kills: row.soft_vehicle_kills,
      armor_kills: row.armor_kills,
      air_kills: row.air_kills,
      deaths: row.deaths
    })),
    pagination: { limit: query.limit, offset: 0, count: result.rows.length }
  };

  if (payload.leaderboard.length === 0) {
    payload.empty_reason = "no_scored_players";
  }

  return payload;
}

export async function registerLeaderboardRoutes(app: FastifyInstance) {
  app.get("/v1/leaderboard/units", async (request, reply) => {
    const auth = await getOptionalAuthContext(request, {
      machineTokenKinds: ["api", "arma_server", "base44_integration"],
      ignoreInvalidCredentials: true
    });

    const parsed = unitLeaderboardQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const query = parsed.data;

    try {
      const revealSensitive = canSeeSensitiveIds(auth.user, auth.machineTokenKind);
      return getUnitLeaderboardPayload(query, revealSensitive);
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to load unit leaderboard");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/public/leaderboard/units", async (request, reply) => {
    const parsed = unitLeaderboardQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    try {
      reply.header("Cache-Control", "public, max-age=60");
      return getUnitLeaderboardPayload(parsed.data, false);
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to load unit leaderboard");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/public/leaderboard/players", async (request, reply) => {
    const parsed = publicPlayerLeaderboardQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    try {
      reply.header("Cache-Control", "public, max-age=60");
      return getPublicPlayerLeaderboardPayload(parsed.data);
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to load public player leaderboard");
      return sendDatabaseUnavailable(reply);
    }
  });
}
