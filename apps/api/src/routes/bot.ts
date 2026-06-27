import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { machineTokenKindSets } from "../auth/machineTokenKinds.js";
import { getAuthContext } from "../auth/authorization.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { sendDatabaseUnavailable, sendForbidden, sendValidationFailed } from "../http/responses.js";

const botPlayerStatsQuerySchema = z
  .object({
    steam_id: z.string().trim().min(1).max(200).optional(),
    discord_user_id: z.string().trim().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0)
  })
  .refine((query) => Boolean(query.steam_id) !== Boolean(query.discord_user_id), {
    message: "Provide exactly one of steam_id or discord_user_id."
  });

type BotPlayerRow = {
  player_uid: string;
  last_name: string | null;
  xp_total: number;
  first_seen_at: Date;
  last_seen_at: Date;
  discord_links: Array<{
    discord_user_id: string;
    discord_username: string | null;
    discord_display_name: string | null;
    source: string;
    verified_at: string | null;
  }>;
};

type BotPlayerStatsRow = {
  operation_count: number;
  xp_total: number;
  present_at_start_count: number;
  present_at_end_count: number;
  infantry_kills: number;
  vehicle_kills: number;
  player_kills: number;
  ai_kills: number;
  friendly_kills: number;
  deaths: number;
  soft_vehicle_kills: number;
  armor_kills: number;
  air_kills: number;
  ground_vehicle_kills: number;
  all_vehicle_kills: number;
  scoreboard_score: number;
};

type BotPlayerMembershipRow = {
  unit_id: string;
  unit_key: string;
  name: string;
  display_name: string | null;
  callsign: string | null;
  rank: string | null;
  rank_id: string | null;
  rank_key: string | null;
  rank_name: string | null;
  rank_short_name: string | null;
  rank_sort: number;
  roster_name: string | null;
  roster_status: string;
  assignment_source: string;
  source_guild_id: string | null;
  source_role_id: string | null;
  is_represented: boolean;
};

type BotPlayerOperationRow = {
  operation_id: string;
  server_key: string;
  status: "finished";
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  present_at_start: boolean;
  present_at_end: boolean;
  name_at_start: string | null;
  name_at_end: string | null;
  side_at_start: string | null;
  side_at_end: string | null;
  group_at_start: string | null;
  group_at_end: string | null;
  role_at_start: string | null;
  role_at_end: string | null;
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

type CountRow = {
  total: number;
};

function sendPlayerNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    ok: false,
    error: {
      code: "player_not_found",
      message: "Player was not found."
    }
  });
}

function defaultStats(xpTotal: number): BotPlayerStatsRow {
  return {
    operation_count: 0,
    xp_total: xpTotal,
    present_at_start_count: 0,
    present_at_end_count: 0,
    infantry_kills: 0,
    vehicle_kills: 0,
    player_kills: 0,
    ai_kills: 0,
    friendly_kills: 0,
    deaths: 0,
    soft_vehicle_kills: 0,
    armor_kills: 0,
    air_kills: 0,
    ground_vehicle_kills: 0,
    all_vehicle_kills: 0,
    scoreboard_score: 0
  };
}

async function findBotPlayer(steamId: string | undefined, discordUserId: string | undefined): Promise<BotPlayerRow | null> {
  const result = await queryDb<BotPlayerRow>(
    `
    WITH candidates AS (
      SELECT
        p.player_uid,
        CASE
          WHEN $1::text IS NOT NULL AND p.player_uid = $1 THEN 0
          WHEN $2::text IS NOT NULL AND p.player_uid NOT LIKE 'discord:%' THEN 1
          WHEN $2::text IS NOT NULL AND p.player_uid = ('discord:' || $2) THEN 2
          ELSE 3
        END AS priority
      FROM players p
      WHERE p.deleted_at IS NULL
        AND (
          ($1::text IS NOT NULL AND p.player_uid = $1)
          OR (
            $2::text IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM player_discord_links lookup_link
              WHERE lookup_link.player_uid = p.player_uid
                AND lookup_link.discord_user_id = $2
            )
          )
          OR ($2::text IS NOT NULL AND p.player_uid = ('discord:' || $2))
        )
      ORDER BY priority ASC, p.last_seen_at DESC, p.player_uid ASC
      LIMIT 1
    )
    SELECT
      p.player_uid,
      p.last_name,
      p.xp_total,
      p.first_seen_at,
      p.last_seen_at,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'discord_user_id', pdl.discord_user_id,
            'discord_username', pdl.discord_username,
            'discord_display_name', pdl.discord_display_name,
            'source', pdl.source,
            'verified_at', pdl.verified_at
          )
          ORDER BY pdl.updated_at DESC, pdl.discord_user_id
        ) FILTER (WHERE pdl.discord_user_id IS NOT NULL),
        '[]'::jsonb
      ) AS discord_links
    FROM candidates c
    JOIN players p ON p.player_uid = c.player_uid
    LEFT JOIN player_discord_links pdl ON pdl.player_uid = p.player_uid
    GROUP BY p.player_uid, c.priority
    ORDER BY c.priority ASC
    LIMIT 1
    `,
    [steamId ?? null, discordUserId ?? null]
  );

  return result.rows[0] ?? null;
}

async function getBotPlayerStats(playerUid: string, xpTotal: number): Promise<BotPlayerStatsRow> {
  const result = await queryDb<BotPlayerStatsRow>(
    `
    SELECT
      COUNT(DISTINCT op.operation_id)::int AS operation_count,
      $2::int AS xp_total,
      COUNT(*) FILTER (WHERE op.present_at_start = true)::int AS present_at_start_count,
      COUNT(*) FILTER (WHERE op.present_at_end = true)::int AS present_at_end_count,
      COALESCE(SUM(ops.infantry_kills), 0)::int AS infantry_kills,
      COALESCE(SUM(ops.vehicle_kills), 0)::int AS vehicle_kills,
      COALESCE(SUM(ops.player_kills), 0)::int AS player_kills,
      COALESCE(SUM(ops.ai_kills), 0)::int AS ai_kills,
      COALESCE(SUM(ops.friendly_kills), 0)::int AS friendly_kills,
      COALESCE(SUM(ops.deaths), 0)::int AS deaths,
      COALESCE(SUM(ops.soft_vehicle_kills), 0)::int AS soft_vehicle_kills,
      COALESCE(SUM(ops.armor_kills), 0)::int AS armor_kills,
      COALESCE(SUM(ops.air_kills), 0)::int AS air_kills,
      COALESCE(SUM(ops.ground_vehicle_kills), 0)::int AS ground_vehicle_kills,
      COALESCE(SUM(ops.all_vehicle_kills), 0)::int AS all_vehicle_kills,
      COALESCE(SUM(ops.scoreboard_score), 0)::int AS scoreboard_score
    FROM operation_players op
    JOIN operations o
      ON o.id = op.operation_id
      AND o.status = 'finished'
    LEFT JOIN operation_player_stats ops
      ON ops.operation_id = op.operation_id
      AND ops.player_uid = op.player_uid
    WHERE op.player_uid = $1
    `,
    [playerUid, xpTotal]
  );

  return result.rows[0] ?? defaultStats(xpTotal);
}

async function getBotPlayerMemberships(playerUid: string): Promise<BotPlayerMembershipRow[]> {
  const result = await queryDb<BotPlayerMembershipRow>(
    `
    SELECT
      u.id AS unit_id,
      u.unit_key,
      u.name,
      u.display_name,
      u.callsign,
      COALESCE(ur.name, up.rank) AS rank,
      up.rank_id,
      ur.rank_key,
      ur.name AS rank_name,
      ur.short_name AS rank_short_name,
      up.rank_sort,
      up.roster_name,
      up.roster_status,
      up.assignment_source,
      up.source_guild_id,
      up.source_role_id,
      COALESCE(pup.represented_unit_id = up.unit_id, false) AS is_represented
    FROM unit_players up
    JOIN units u ON u.id = up.unit_id
    LEFT JOIN unit_ranks ur ON ur.id = up.rank_id
    LEFT JOIN player_unit_preferences pup ON pup.player_uid = up.player_uid
    WHERE up.player_uid = $1
      AND up.is_active = true
      AND up.roster_status <> 'inactive'
      AND u.is_active = true
      AND u.deleted_at IS NULL
    ORDER BY
      COALESCE(pup.represented_unit_id = up.unit_id, false) DESC,
      u.sort_order ASC,
      u.name ASC
    `,
    [playerUid]
  );

  return result.rows;
}

async function getBotPlayerOperationCount(playerUid: string): Promise<number> {
  const result = await queryDb<CountRow>(
    `
    SELECT COUNT(*)::int AS total
    FROM operation_players op
    JOIN operations o
      ON o.id = op.operation_id
      AND o.status = 'finished'
    WHERE op.player_uid = $1
    `,
    [playerUid]
  );

  return result.rows[0]?.total ?? 0;
}

async function getBotPlayerOperations(playerUid: string, limit: number, offset: number): Promise<BotPlayerOperationRow[]> {
  const result = await queryDb<BotPlayerOperationRow>(
    `
    SELECT
      o.id AS operation_id,
      o.server_key,
      o.status,
      o.mission_uid,
      o.mission_name,
      o.world_name,
      o.started_at,
      o.ended_at,
      op.present_at_start,
      op.present_at_end,
      op.name_at_start,
      op.name_at_end,
      op.side_at_start,
      op.side_at_end,
      op.group_at_start,
      op.group_at_end,
      op.role_at_start,
      op.role_at_end,
      ops.infantry_kills,
      ops.vehicle_kills,
      ops.player_kills,
      ops.ai_kills,
      ops.friendly_kills,
      ops.deaths,
      ops.soft_vehicle_kills,
      ops.armor_kills,
      ops.air_kills,
      ops.ground_vehicle_kills,
      ops.all_vehicle_kills,
      ops.scoreboard_score
    FROM operation_players op
    JOIN operations o
      ON o.id = op.operation_id
      AND o.status = 'finished'
    LEFT JOIN operation_player_stats ops
      ON ops.operation_id = op.operation_id
      AND ops.player_uid = op.player_uid
    WHERE op.player_uid = $1
    ORDER BY COALESCE(o.ended_at, o.started_at) DESC, o.id DESC
    LIMIT $2 OFFSET $3
    `,
    [playerUid, limit, offset]
  );

  return result.rows;
}

export async function registerBotRoutes(app: FastifyInstance) {
  app.get("/v1/bot/player-stats", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { machineTokenKinds: machineTokenKindSets.botWriter });

    if (!auth) {
      return;
    }

    if (auth.kind !== "machine") {
      return sendForbidden(reply, "Bot player stats require a bot or API machine token.");
    }

    const parsedQuery = botPlayerStatsQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const query = parsedQuery.data;

    try {
      const player = await findBotPlayer(query.steam_id, query.discord_user_id);

      if (!player) {
        return sendPlayerNotFound(reply);
      }

      const [stats, memberships, totalOperations, operations] = await Promise.all([
        getBotPlayerStats(player.player_uid, player.xp_total),
        getBotPlayerMemberships(player.player_uid),
        getBotPlayerOperationCount(player.player_uid),
        getBotPlayerOperations(player.player_uid, query.limit, query.offset)
      ]);
      const primaryMembership = memberships.find((membership) => membership.is_represented) ?? memberships[0] ?? null;

      return {
        ok: true,
        lookup: {
          steam_id: query.steam_id ?? null,
          discord_user_id: query.discord_user_id ?? null,
          resolved_player_uid: player.player_uid
        },
        player: {
          player_uid: player.player_uid,
          display_name: primaryMembership?.roster_name ?? player.last_name,
          last_name: player.last_name,
          xp_total: player.xp_total,
          rank: primaryMembership?.rank ?? null,
          represented_unit_id: memberships.find((membership) => membership.is_represented)?.unit_id ?? null,
          first_seen_at: player.first_seen_at,
          last_seen_at: player.last_seen_at,
          discord_links: player.discord_links
        },
        battalion_memberships: memberships.map((membership) => ({
          unit_id: membership.unit_id,
          unit_key: membership.unit_key,
          name: membership.display_name ?? membership.name,
          callsign: membership.callsign,
          rank: membership.rank,
          rank_id: membership.rank_id,
          rank_key: membership.rank_key,
          rank_name: membership.rank_name,
          rank_short_name: membership.rank_short_name,
          rank_sort: membership.rank_sort,
          roster_name: membership.roster_name,
          roster_status: membership.roster_status,
          assignment_source: membership.assignment_source,
          source_guild_id: membership.source_guild_id,
          source_role_id: membership.source_role_id,
          is_represented: membership.is_represented
        })),
        stats,
        scoreboard_totals: {
          infantry_kills: stats.infantry_kills,
          soft_vehicle_kills: stats.soft_vehicle_kills,
          armor_kills: stats.armor_kills,
          ground_vehicle_kills: stats.ground_vehicle_kills,
          air_kills: stats.air_kills,
          all_vehicle_kills: stats.all_vehicle_kills,
          deaths: stats.deaths,
          score: stats.scoreboard_score
        },
        attended_operations: operations.map((operation) => ({
          operation_id: operation.operation_id,
          server_key: operation.server_key,
          status: operation.status,
          mission_uid: operation.mission_uid,
          mission_name: operation.mission_name,
          world_name: operation.world_name,
          started_at: operation.started_at,
          ended_at: operation.ended_at,
          present_at_start: operation.present_at_start,
          present_at_end: operation.present_at_end,
          name_at_start: operation.name_at_start,
          name_at_end: operation.name_at_end,
          side_at_start: operation.side_at_start,
          side_at_end: operation.side_at_end,
          group_at_start: operation.group_at_start,
          group_at_end: operation.group_at_end,
          role_at_start: operation.role_at_start,
          role_at_end: operation.role_at_end,
          stats: {
            infantry_kills: operation.infantry_kills ?? 0,
            vehicle_kills: operation.vehicle_kills ?? 0,
            player_kills: operation.player_kills ?? 0,
            ai_kills: operation.ai_kills ?? 0,
            friendly_kills: operation.friendly_kills ?? 0,
            deaths: operation.deaths ?? 0
          },
          scoreboard_stats: {
            infantry_kills: operation.infantry_kills ?? 0,
            soft_vehicle_kills: operation.soft_vehicle_kills ?? 0,
            armor_kills: operation.armor_kills ?? 0,
            ground_vehicle_kills: operation.ground_vehicle_kills ?? 0,
            air_kills: operation.air_kills ?? 0,
            all_vehicle_kills: operation.all_vehicle_kills ?? 0,
            deaths: operation.deaths ?? 0,
            score: operation.scoreboard_score ?? 0
          }
        })),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          count: operations.length,
          total: totalOperations
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to load bot player stats");
      return sendDatabaseUnavailable(reply);
    }
  });
}
