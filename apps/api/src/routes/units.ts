import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { hasRole, type CurrentUser } from "../auth.js";
import { canSeeSensitiveIds, deny, getAuthContext } from "../auth/authorization.js";
import { getUserUnitRoles, hasUnitRole, requireUnitAdmin, requireUnitMember } from "../auth/units.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";
import { type DbTransaction, withDbTransaction } from "../db/transactions.js";

const listUnitsQuerySchema = z.object({
  include_inactive: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const playerCandidateQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

const unitParamsSchema = z.object({
  unit_id: z.string().uuid()
});

const playerParamsSchema = unitParamsSchema.extend({
  player_uid: z.string().min(1).max(200)
});

const rankParamsSchema = unitParamsSchema.extend({
  rank_id: z.string().uuid()
});

const squadParamsSchema = unitParamsSchema.extend({
  squad_id: z.string().uuid()
});

const createUnitBodySchema = z.object({
  unit_key: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(160),
  display_name: z.string().max(160).nullable().optional(),
  callsign: z.string().max(120).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  emblem_url: z.string().url().max(500).nullable().optional()
});

const updateUnitBodySchema = z.object({
  unit_key: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().min(1).max(160).optional(),
  display_name: z.string().max(160).nullable().optional(),
  callsign: z.string().max(120).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  emblem_url: z.string().url().max(500).nullable().optional(),
  sort_order: z.number().int().min(-100000).max(100000).optional(),
  is_active: z.boolean().optional()
});

const rosterStatusSchema = z.enum(["active", "reserve", "loa", "inactive"]);

const upsertUnitPlayerBodySchema = z.object({
  player_uid: z.string().min(1).max(200),
  discord_user_id: z.string().max(80).optional(),
  roster_name: z.string().min(1).max(200).nullable().optional(),
  rank: z.string().max(80).nullable().optional(),
  rank_id: z.string().uuid().nullable().optional(),
  roster_status: rosterStatusSchema.default("active"),
  notes: z.string().max(1000).nullable().optional()
});

const updateUnitPlayerBodySchema = z.object({
  roster_name: z.string().min(1).max(200).nullable().optional(),
  rank: z.string().max(80).nullable().optional(),
  rank_id: z.string().uuid().nullable().optional(),
  roster_status: rosterStatusSchema.optional(),
  notes: z.string().max(1000).nullable().optional()
});

const createRankBodySchema = z.object({
  rank_key: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(120),
  short_name: z.string().max(40).nullable().optional(),
  sort_order: z.number().int().min(-100000).max(100000).default(0)
});

const updateRankBodySchema = z.object({
  rank_key: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().min(1).max(120).optional(),
  short_name: z.string().max(40).nullable().optional(),
  sort_order: z.number().int().min(-100000).max(100000).optional(),
  is_active: z.boolean().optional()
});

const squadTypeSchema = z.enum(["company", "platoon", "squad", "fireteam", "detachment"]);
const hierarchyModeSchema = z.enum(["flat", "tree"]);

const createSquadBodySchema = z.object({
  parent_squad_id: z.string().uuid().nullable().optional(),
  squad_key: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(140),
  squad_type: squadTypeSchema.default("squad"),
  hierarchy_mode: hierarchyModeSchema.default("flat"),
  sort_order: z.number().int().min(-100000).max(100000).default(0)
});

const updateSquadBodySchema = z.object({
  parent_squad_id: z.string().uuid().nullable().optional(),
  squad_key: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().min(1).max(140).optional(),
  squad_type: squadTypeSchema.optional(),
  hierarchy_mode: hierarchyModeSchema.optional(),
  sort_order: z.number().int().min(-100000).max(100000).optional(),
  is_active: z.boolean().optional()
});

const billetSchema = z.enum(["unassigned", "squad_lead", "fireteam_lead", "trooper"]);

const squadLayoutBodySchema = z.object({
  squads: z.array(
    z.object({
      id: z.string().uuid(),
      parent_squad_id: z.string().uuid().nullable(),
      sort_order: z.number().int().min(-100000).max(100000)
    })
  ).default([]),
  assignments: z.array(
    z.object({
      player_uid: z.string().min(1).max(200),
      squad_id: z.string().uuid().nullable(),
      billet: billetSchema,
      sort_order: z.number().int().min(-100000).max(100000)
    })
  ).default([])
});

const unitAdminBodySchema = z.object({
  role: z.enum(["officer", "admin", "tcw_admin"]).default("admin")
});

type UnitRole = "member" | "officer" | "admin" | "tcw_admin";

type UnitListRow = {
  unit_id: string;
  unit_key: string;
  name: string;
  display_name: string | null;
  callsign: string | null;
  description: string | null;
  emblem_url: string | null;
  sort_order: number;
  is_active: boolean;
  member_count: number;
  unassigned_count: number;
  squad_count: number;
};

type UnitRow = {
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

type RankRow = {
  id: string;
  unit_id: string;
  rank_key: string;
  name: string;
  short_name: string | null;
  sort_order: number;
  is_active: boolean;
};

type SquadRow = {
  id: string;
  unit_id: string;
  parent_squad_id: string | null;
  squad_key: string;
  name: string;
  squad_type: string;
  hierarchy_mode: string;
  sort_order: number;
  is_active: boolean;
};

type RosterPlayerRow = {
  player_uid: string;
  last_name: string | null;
  roster_name: string | null;
  rank: string | null;
  rank_id: string | null;
  rank_name: string | null;
  rank_sort: number;
  roster_status: string;
  notes: string | null;
  squad_id: string | null;
  billet: string | null;
  assignment_sort: number | null;
};

type PlayerCandidateRow = {
  player_uid: string;
  last_name: string | null;
  last_seen_at: Date;
  operation_count: number;
};

type AdminRow = {
  user_id: string;
  display_name: string | null;
  role: UnitRole;
  granted_at: Date;
};

type SanitizedRosterPlayer = {
  player_uid: string | null;
  roster_name: string;
  player_name: string | null;
  rank: string | null;
  rank_id: string | null;
  rank_sort: number;
  roster_status: string;
  notes: string | null;
  squad_id: string | null;
  billet: string;
  sort_order: number;
};

type SquadNode = {
  id: string;
  parent_squad_id: string | null;
  squad_key: string;
  name: string;
  squad_type: string;
  hierarchy_mode: string;
  sort_order: number;
  leader: SanitizedRosterPlayer | null;
  leaders: SanitizedRosterPlayer[];
  squad_leaders: SanitizedRosterPlayer[];
  fireteam_leaders: SanitizedRosterPlayer[];
  members: SanitizedRosterPlayer[];
  children: SquadNode[];
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

function notFound(reply: FastifyReply, code: string, message: string) {
  return reply.code(404).send({
    ok: false,
    error: {
      code,
      message
    }
  });
}

function conflict(reply: FastifyReply, code: string, message: string) {
  return reply.code(409).send({
    ok: false,
    error: {
      code,
      message
    }
  });
}

function sendSquadCycleDetected(reply: FastifyReply) {
  return reply.code(400).send({
    ok: false,
    error: {
      code: "squad_cycle_detected",
      message: "Squad hierarchy cannot contain cycles."
    }
  });
}

function actorLabel(user: CurrentUser): string {
  return user.display_name ?? user.id;
}

async function audit(
  tx: DbTransaction,
  user: CurrentUser,
  action: string,
  details: Record<string, unknown>,
  targetUserId: string | null = null
) {
  await tx.query(
    `
    INSERT INTO admin_audit_events (actor_user_id, actor_label, action, target_user_id, details)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [user.id, actorLabel(user), action, targetUserId, JSON.stringify(details)]
  );
}

function withMyRoles(row: UnitListRow, roleMap: Map<string, UnitRole[]>) {
  return {
    unit_id: row.unit_id,
    unit_key: row.unit_key,
    name: row.name,
    display_name: row.display_name ?? row.name,
    callsign: row.callsign,
    description: row.description,
    emblem_url: row.emblem_url,
    sort_order: row.sort_order,
    is_active: row.is_active,
    member_count: row.member_count,
    unassigned_count: row.unassigned_count,
    squad_count: row.squad_count,
    my_roles: roleMap.get(row.unit_id) ?? []
  };
}

async function getListableUnitIds(user: CurrentUser | null): Promise<{ all: boolean; unitIds: string[]; roles: Map<string, UnitRole[]> }> {
  if (user === null) {
    return { all: true, unitIds: [], roles: new Map() };
  }

  const roleRows = await getUserUnitRoles(user.id);
  const roles = new Map<string, UnitRole[]>();

  for (const row of roleRows) {
    roles.set(row.unit_id, [...(roles.get(row.unit_id) ?? []), row.role]);
  }

  if (hasRole(user, ["owner"]) || (hasRole(user, ["tcw_admin"]) && roleRows.length === 0)) {
    return { all: true, unitIds: [], roles };
  }

  return { all: false, unitIds: Array.from(roles.keys()), roles };
}

async function unitExists(unitId: string): Promise<boolean> {
  const result = await queryDb<{ id: string }>("SELECT id FROM units WHERE id = $1 AND deleted_at IS NULL", [unitId]);
  return Boolean(result.rows[0]);
}

async function ensureUnitAdmin(user: CurrentUser, unitId: string, reply: FastifyReply): Promise<boolean> {
  if (!(await unitExists(unitId))) {
    notFound(reply, "unit_not_found", "Battalion was not found.");
    return false;
  }

  return requireUnitAdmin(user, unitId, reply);
}

function sanitizeRosterPlayer(row: RosterPlayerRow, revealSensitive: boolean): SanitizedRosterPlayer {
  return {
    player_uid: revealSensitive ? row.player_uid : null,
    roster_name: row.roster_name ?? row.last_name ?? row.player_uid,
    player_name: row.last_name,
    rank: row.rank_name ?? row.rank,
    rank_id: row.rank_id,
    rank_sort: row.rank_sort,
    roster_status: row.roster_status,
    notes: revealSensitive ? row.notes : null,
    squad_id: row.squad_id,
    billet: row.billet ?? "unassigned",
    sort_order: row.assignment_sort ?? 0
  };
}

function buildSquadTree(squads: SquadRow[], players: SanitizedRosterPlayer[]): SquadNode[] {
  const nodes = new Map<string, SquadNode>();

  for (const squad of squads) {
    nodes.set(squad.id, buildSquadNode(squad));
  }

  for (const player of players) {
    if (!player.squad_id) {
      continue;
    }

    const node = nodes.get(player.squad_id);

    if (!node) {
      continue;
    }

    if (player.billet === "squad_lead") {
      node.squad_leaders.push(player);
      node.leaders.push(player);
      node.leader ??= player;
    } else if (player.billet === "fireteam_lead") {
      node.fireteam_leaders.push(player);
      node.leaders.push(player);
      node.leader ??= player;
    } else {
      node.members.push(player);
    }
  }

  const roots: SquadNode[] = [];

  for (const squad of squads) {
    const node = nodes.get(squad.id);

    if (!node) {
      continue;
    }

    if (squad.parent_squad_id && nodes.has(squad.parent_squad_id)) {
      nodes.get(squad.parent_squad_id)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function buildSquadNode(squad: SquadRow): SquadNode {
  return {
    id: squad.id,
    parent_squad_id: squad.parent_squad_id,
    squad_key: squad.squad_key,
    name: squad.name,
    squad_type: squad.squad_type,
    hierarchy_mode: squad.hierarchy_mode,
    sort_order: squad.sort_order,
    leader: null,
    leaders: [],
    squad_leaders: [],
    fireteam_leaders: [],
    members: [],
    children: []
  };
}

async function validateSquadHierarchy(
  tx: DbTransaction,
  reply: FastifyReply,
  unitId: string,
  proposed: Array<{ id: string; parent_squad_id: string | null }>
): Promise<boolean> {
  const result = await tx.query<{ id: string; parent_squad_id: string | null }>(
    `
    SELECT id, parent_squad_id
    FROM unit_squads
    WHERE unit_id = $1 AND is_active = true
    `,
    [unitId]
  );
  const parents = new Map(result.rows.map((row) => [row.id, row.parent_squad_id]));

  for (const squad of proposed) {
    if (!parents.has(squad.id)) {
      sendValidationFailed(reply);
      return false;
    }

    if (squad.parent_squad_id && !parents.has(squad.parent_squad_id)) {
      notFound(reply, "parent_squad_not_found", "Parent squad was not found in this battalion.");
      return false;
    }

    parents.set(squad.id, squad.parent_squad_id);
  }

  for (const squadId of parents.keys()) {
    const seen = new Set<string>();
    let current: string | null | undefined = squadId;

    while (current) {
      if (seen.has(current)) {
        sendSquadCycleDetected(reply);
        return false;
      }

      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }

  return true;
}

async function insertDefaultRanks(tx: DbTransaction, unitId: string) {
  const ranks = [
    ["recruit", "Recruit", "RCT", 10],
    ["trooper", "Trooper", "TRP", 20],
    ["corporal", "Corporal", "CPL", 30],
    ["sergeant", "Sergeant", "SGT", 40],
    ["lieutenant", "Lieutenant", "LT", 50],
    ["captain", "Captain", "CPT", 60],
    ["commander", "Commander", "CDR", 70]
  ] as const;

  for (const [rankKey, name, shortName, sortOrder] of ranks) {
    await tx.query(
      `
      INSERT INTO unit_ranks (unit_id, rank_key, name, short_name, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (unit_id, rank_key) DO NOTHING
      `,
      [unitId, rankKey, name, shortName, sortOrder]
    );
  }
}

export async function registerUnitRoutes(app: FastifyInstance) {
  app.get("/v1/units", async (request, reply) => {
    const auth = await getAuthContext(request, reply, { machineTokenKinds: ["api", "arma_server", "base44_integration"] });

    if (!auth) {
      return;
    }

    const parsed = listUnitsQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const query = parsed.data;
    const includeInactive = auth.user !== null && hasRole(auth.user, ["owner"]) && query.include_inactive;
    const visible = await getListableUnitIds(auth.user);

    if (!visible.all && visible.unitIds.length === 0) {
      return {
        ok: true,
        units: [],
        pagination: { limit: query.limit, offset: query.offset, count: 0 }
      };
    }

    const values: unknown[] = [];
    const where = ["u.deleted_at IS NULL"];

    if (!includeInactive) {
      where.push("u.is_active = true");
    }

    if (!visible.all) {
      values.push(visible.unitIds);
      where.push(`u.id = ANY($${values.length}::uuid[])`);
    }

    values.push(query.limit);
    const limitParam = values.length;
    values.push(query.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb<UnitListRow>(
        `
        SELECT
          u.id AS unit_id,
          u.unit_key,
          u.name,
          u.display_name,
          u.callsign,
          u.description,
          u.emblem_url,
          u.sort_order,
          u.is_active,
          COUNT(DISTINCT up.player_uid)::int AS member_count,
          COUNT(DISTINCT up.player_uid) FILTER (
            WHERE up.is_active = true
              AND (ura.id IS NULL OR ura.squad_id IS NULL OR ura.billet = 'unassigned')
          )::int AS unassigned_count,
          COUNT(DISTINCT us.id) FILTER (WHERE us.is_active = true)::int AS squad_count
        FROM units u
        LEFT JOIN unit_players up ON up.unit_id = u.id AND up.is_active = true AND up.roster_status <> 'inactive'
        LEFT JOIN unit_roster_assignments ura
          ON ura.unit_id = u.id
          AND ura.player_uid = up.player_uid
          AND ura.ended_at IS NULL
          AND ura.is_primary = true
        LEFT JOIN unit_squads us ON us.unit_id = u.id AND us.is_active = true
        WHERE ${where.join(" AND ")}
        GROUP BY u.id
        ORDER BY u.sort_order ASC, u.name ASC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return {
        ok: true,
        units: result.rows.map((row) => withMyRoles(row, visible.roles)),
        pagination: { limit: query.limit, offset: query.offset, count: result.rows.length }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list units");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/units", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    if (!hasRole(auth.user, ["owner"])) {
      return deny(reply);
    }

    const parsed = createUnitBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    try {
      return await withDbTransaction(async (tx) => {
        const result = await tx.query<UnitRow>(
          `
          INSERT INTO units (unit_key, slug, name, display_name, callsign, description, emblem_url)
          VALUES ($1, $1, $2, $3, $4, $5, $6)
          ON CONFLICT (unit_key) DO UPDATE
          SET slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              display_name = EXCLUDED.display_name,
              callsign = EXCLUDED.callsign,
              description = EXCLUDED.description,
              emblem_url = EXCLUDED.emblem_url,
              is_active = true,
              deleted_at = NULL,
              updated_at = now()
          RETURNING id, unit_key, name, display_name, callsign, description, emblem_url, sort_order, is_active
          `,
          [
            parsed.data.unit_key,
            parsed.data.name,
            parsed.data.display_name ?? parsed.data.name,
            parsed.data.callsign ?? null,
            parsed.data.description ?? null,
            parsed.data.emblem_url ?? null
          ]
        );
        const unit = result.rows[0];

        if (!unit) {
          throw new Error("Unit insert returned no row.");
        }

        await insertDefaultRanks(tx, unit.id);
        await audit(tx, auth.user, "create_unit", { unit_id: unit.id, unit_key: unit.unit_key });

        return { ok: true, unit };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create unit");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/units/:unit_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);
    const parsedBody = updateUnitBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId } = parsedParams.data;
    const isOwner = hasRole(auth.user, ["owner"]);

    if (!isOwner && !(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    const ownerFields = ["unit_key", "name", "is_active"] as const;

    if (!isOwner && ownerFields.some((field) => field in parsedBody.data)) {
      return deny(reply);
    }

    try {
      return await withDbTransaction(async (tx) => {
        const result = await tx.query<UnitRow>(
          `
          UPDATE units
          SET
            unit_key = COALESCE($2, unit_key),
            slug = COALESCE($2, slug),
            name = COALESCE($3, name),
            display_name = COALESCE($4, display_name),
            callsign = $5,
            description = $6,
            emblem_url = $7,
            sort_order = COALESCE($8, sort_order),
            is_active = COALESCE($9, is_active),
            deleted_at = CASE WHEN $9 = true THEN NULL ELSE deleted_at END,
            updated_at = now()
          WHERE id = $1
            AND deleted_at IS NULL
          RETURNING id, unit_key, name, display_name, callsign, description, emblem_url, sort_order, is_active
          `,
          [
            unitId,
            parsedBody.data.unit_key ?? null,
            parsedBody.data.name ?? null,
            parsedBody.data.display_name ?? null,
            parsedBody.data.callsign ?? null,
            parsedBody.data.description ?? null,
            parsedBody.data.emblem_url ?? null,
            parsedBody.data.sort_order ?? null,
            parsedBody.data.is_active ?? null
          ]
        );
        const unit = result.rows[0];

        if (!unit) {
          return notFound(reply, "unit_not_found", "Battalion was not found.");
        }

        await audit(tx, auth.user, "update_unit", { unit_id: unitId, fields: Object.keys(parsedBody.data) });

        return { ok: true, unit };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update unit");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/units/:unit_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    if (!hasRole(auth.user, ["owner"])) {
      return deny(reply);
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId } = parsedParams.data;

    try {
      return await withDbTransaction(async (tx) => {
        const countsResult = await tx.query<{
          operation_count: number;
          roster_count: number;
          squad_count: number;
        }>(
          `
          SELECT
            (SELECT COUNT(*)::int FROM operations WHERE unit_id = $1) AS operation_count,
            (SELECT COUNT(*)::int FROM unit_players WHERE unit_id = $1) AS roster_count,
            (SELECT COUNT(*)::int FROM unit_squads WHERE unit_id = $1) AS squad_count
          `,
          [unitId]
        );

        const result = await tx.query<{ id: string }>(
          `
          UPDATE units
          SET is_active = false, deleted_at = COALESCE(deleted_at, now()), updated_at = now()
          WHERE id = $1
          RETURNING id
          `,
          [unitId]
        );

        if (!result.rows[0]) {
          return notFound(reply, "unit_not_found", "Battalion was not found.");
        }

        const counts = countsResult.rows[0] ?? { operation_count: 0, roster_count: 0, squad_count: 0 };
        await audit(tx, auth.user, "deactivate_unit", { unit_id: unitId, counts });

        return { ok: true, unit_id: unitId, deleted: true, counts };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to delete unit");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/units/:unit_id/roster", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId } = parsedParams.data;

    if (!(await requireUnitMember(auth.user, unitId, reply))) {
      return;
    }

    try {
      const [unitResult, ranksResult, squadsResult, playersResult] = await Promise.all([
        queryDb<UnitRow>(
          `
          SELECT id, unit_key, name, display_name, callsign, description, emblem_url, sort_order, is_active
          FROM units
          WHERE id = $1 AND deleted_at IS NULL
          `,
          [unitId]
        ),
        queryDb<RankRow>(
          `
          SELECT id, unit_id, rank_key, name, short_name, sort_order, is_active
          FROM unit_ranks
          WHERE unit_id = $1 AND is_active = true
          ORDER BY sort_order, name
          `,
          [unitId]
        ),
        queryDb<SquadRow>(
          `
          SELECT id, unit_id, parent_squad_id, squad_key, name, squad_type, hierarchy_mode, sort_order, is_active
          FROM unit_squads
          WHERE unit_id = $1 AND is_active = true
          ORDER BY sort_order, name
          `,
          [unitId]
        ),
        queryDb<RosterPlayerRow>(
          `
          SELECT
            up.player_uid,
            p.last_name,
            up.roster_name,
            up.rank,
            up.rank_id,
            ur.name AS rank_name,
            up.rank_sort,
            up.roster_status,
            up.notes,
            ura.squad_id,
            ura.billet,
            ura.sort_order AS assignment_sort
          FROM unit_players up
          JOIN players p ON p.player_uid = up.player_uid
          LEFT JOIN unit_ranks ur ON ur.id = up.rank_id
          LEFT JOIN unit_roster_assignments ura
            ON ura.unit_id = up.unit_id
            AND ura.player_uid = up.player_uid
            AND ura.ended_at IS NULL
            AND ura.is_primary = true
          WHERE up.unit_id = $1
            AND up.is_active = true
            AND up.roster_status <> 'inactive'
          ORDER BY up.rank_sort, COALESCE(ura.sort_order, 0), COALESCE(up.roster_name, p.last_name, up.player_uid)
          `,
          [unitId]
        )
      ]);

      const unit = unitResult.rows[0];

      if (!unit) {
        return notFound(reply, "unit_not_found", "Battalion was not found.");
      }

      const revealSensitive = canSeeSensitiveIds(auth.user) || (await hasUnitRole(auth.user, unitId, "admin"));
      const rosterPlayers = playersResult.rows.map((row) => sanitizeRosterPlayer(row, revealSensitive));
      const unassigned = rosterPlayers.filter((player) => !player.squad_id || player.billet === "unassigned");

      return {
        ok: true,
        unit,
        ranks: ranksResult.rows,
        unassigned,
        squads: buildSquadTree(squadsResult.rows, rosterPlayers)
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch unit roster");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/units/:unit_id/player-candidates", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);
    const parsedQuery = playerCandidateQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId } = parsedParams.data;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    const values: unknown[] = [];
    const where = [
      `NOT EXISTS (
        SELECT 1
        FROM unit_players up_existing
        JOIN units u_existing ON u_existing.id = up_existing.unit_id
        WHERE up_existing.player_uid = p.player_uid
          AND up_existing.is_active = true
          AND up_existing.roster_status <> 'inactive'
          AND u_existing.is_active = true
          AND u_existing.deleted_at IS NULL
      )`
    ];

    if (parsedQuery.data.q && parsedQuery.data.q.trim().length > 0) {
      values.push(`%${parsedQuery.data.q.trim()}%`);
      where.push(`(p.player_uid ILIKE $${values.length} OR p.last_name ILIKE $${values.length})`);
    }

    values.push(parsedQuery.data.limit);
    const limitParam = values.length;

    try {
      const result = await queryDb<PlayerCandidateRow>(
        `
        SELECT
          p.player_uid,
          p.last_name,
          p.last_seen_at,
          COUNT(DISTINCT op.operation_id)::int AS operation_count
        FROM players p
        LEFT JOIN operation_players op ON op.player_uid = p.player_uid
        WHERE ${where.join(" AND ")}
        GROUP BY p.player_uid
        ORDER BY p.last_seen_at DESC, p.player_uid
        LIMIT $${limitParam}
        `,
        values
      );

      return { ok: true, players: result.rows };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list unit player candidates");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/units/:unit_id/players", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);
    const parsedBody = upsertUnitPlayerBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId } = parsedParams.data;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const displayName = parsedBody.data.roster_name ?? parsedBody.data.player_uid;

        await tx.query(
          `
          INSERT INTO players (player_uid, last_name, raw_last_player)
          VALUES ($1, $2, '{"source":"manual-roster"}'::jsonb)
          ON CONFLICT (player_uid) DO UPDATE
          SET last_name = COALESCE(players.last_name, EXCLUDED.last_name),
              updated_at = now()
          `,
          [parsedBody.data.player_uid, displayName]
        );

        const result = await tx.query(
          `
          INSERT INTO unit_players (
            unit_id,
            player_uid,
            rank,
            rank_id,
            roster_name,
            roster_status,
            notes,
            is_active,
            joined_unit_at,
            left_unit_at,
            assignment_source
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, true, now(), NULL, 'manual')
          ON CONFLICT (unit_id, player_uid) DO UPDATE
          SET rank = EXCLUDED.rank,
              rank_id = EXCLUDED.rank_id,
              roster_name = EXCLUDED.roster_name,
              roster_status = EXCLUDED.roster_status,
              notes = EXCLUDED.notes,
              is_active = true,
              left_unit_at = NULL,
              updated_at = now()
          RETURNING unit_id, player_uid, rank, rank_id, roster_name, roster_status, notes
          `,
          [
            unitId,
            parsedBody.data.player_uid,
            parsedBody.data.rank ?? null,
            parsedBody.data.rank_id ?? null,
            parsedBody.data.roster_name ?? displayName,
            parsedBody.data.roster_status,
            parsedBody.data.notes ?? null
          ]
        );

        await audit(tx, auth.user, "add_unit_player", { unit_id: unitId, player_uid: parsedBody.data.player_uid });

        return { ok: true, player: result.rows[0] };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to add unit player");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/units/:unit_id/players/:player_uid", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = playerParamsSchema.safeParse(request.params);
    const parsedBody = updateUnitPlayerBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId, player_uid: playerUid } = parsedParams.data;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const result = await tx.query(
          `
          UPDATE unit_players
          SET
            roster_name = CASE WHEN $3 THEN $4 ELSE roster_name END,
            rank = CASE WHEN $5 THEN $6 ELSE rank END,
            rank_id = CASE WHEN $7 THEN $8 ELSE rank_id END,
            roster_status = CASE WHEN $9 THEN $10 ELSE roster_status END,
            notes = CASE WHEN $11 THEN $12 ELSE notes END,
            updated_at = now()
          WHERE unit_id = $1 AND player_uid = $2
          RETURNING unit_id, player_uid, rank, rank_id, roster_name, roster_status, notes
          `,
          [
            unitId,
            playerUid,
            Object.hasOwn(parsedBody.data, "roster_name"),
            parsedBody.data.roster_name ?? null,
            Object.hasOwn(parsedBody.data, "rank"),
            parsedBody.data.rank ?? null,
            Object.hasOwn(parsedBody.data, "rank_id"),
            parsedBody.data.rank_id ?? null,
            Object.hasOwn(parsedBody.data, "roster_status"),
            parsedBody.data.roster_status ?? null,
            Object.hasOwn(parsedBody.data, "notes"),
            parsedBody.data.notes ?? null
          ]
        );

        if (!result.rows[0]) {
          return notFound(reply, "unit_player_not_found", "Battalion roster player was not found.");
        }

        await audit(tx, auth.user, "update_unit_player", { unit_id: unitId, player_uid: playerUid });

        return { ok: true, player: result.rows[0] };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update unit player");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/units/:unit_id/players/:player_uid", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = playerParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId, player_uid: playerUid } = parsedParams.data;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const result = await tx.query<{ player_uid: string }>(
          `
          UPDATE unit_players
          SET is_active = false,
              roster_status = 'inactive',
              left_unit_at = now(),
              updated_at = now()
          WHERE unit_id = $1 AND player_uid = $2
          RETURNING player_uid
          `,
          [unitId, playerUid]
        );

        await tx.query(
          `
          UPDATE unit_roster_assignments
          SET ended_at = COALESCE(ended_at, now()), updated_at = now()
          WHERE unit_id = $1 AND player_uid = $2 AND ended_at IS NULL
          `,
          [unitId, playerUid]
        );

        if (!result.rows[0]) {
          return notFound(reply, "unit_player_not_found", "Battalion roster player was not found.");
        }

        await audit(tx, auth.user, "remove_unit_player", { unit_id: unitId, player_uid: playerUid });

        return { ok: true, player_uid: playerUid, removed: true };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to remove unit player");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/units/:unit_id/ranks", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    if (!(await requireUnitMember(auth.user, parsedParams.data.unit_id, reply))) {
      return;
    }

    const result = await queryDb<RankRow>(
      `
      SELECT id, unit_id, rank_key, name, short_name, sort_order, is_active
      FROM unit_ranks
      WHERE unit_id = $1 AND is_active = true
      ORDER BY sort_order, name
      `,
      [parsedParams.data.unit_id]
    );

    return { ok: true, ranks: result.rows };
  });

  app.post("/v1/units/:unit_id/ranks", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);
    const parsedBody = createRankBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const unitId = parsedParams.data.unit_id;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const result = await tx.query<RankRow>(
          `
          INSERT INTO unit_ranks (unit_id, rank_key, name, short_name, sort_order)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, unit_id, rank_key, name, short_name, sort_order, is_active
          `,
          [unitId, parsedBody.data.rank_key, parsedBody.data.name, parsedBody.data.short_name ?? null, parsedBody.data.sort_order]
        );

        await audit(tx, auth.user, "create_unit_rank", { unit_id: unitId, rank_id: result.rows[0]?.id });

        return { ok: true, rank: result.rows[0] };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create unit rank");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/units/:unit_id/ranks/:rank_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = rankParamsSchema.safeParse(request.params);
    const parsedBody = updateRankBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId, rank_id: rankId } = parsedParams.data;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const result = await tx.query<RankRow>(
          `
          UPDATE unit_ranks
          SET rank_key = COALESCE($3, rank_key),
              name = COALESCE($4, name),
              short_name = $5,
              sort_order = COALESCE($6, sort_order),
              is_active = COALESCE($7, is_active),
              updated_at = now()
          WHERE unit_id = $1 AND id = $2
          RETURNING id, unit_id, rank_key, name, short_name, sort_order, is_active
          `,
          [
            unitId,
            rankId,
            parsedBody.data.rank_key ?? null,
            parsedBody.data.name ?? null,
            parsedBody.data.short_name ?? null,
            parsedBody.data.sort_order ?? null,
            parsedBody.data.is_active ?? null
          ]
        );

        if (!result.rows[0]) {
          return notFound(reply, "rank_not_found", "Battalion rank was not found.");
        }

        await audit(tx, auth.user, "update_unit_rank", { unit_id: unitId, rank_id: rankId });

        return { ok: true, rank: result.rows[0] };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update unit rank");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/units/:unit_id/ranks/:rank_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = rankParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId, rank_id: rankId } = parsedParams.data;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const result = await tx.query<{ id: string }>(
          "UPDATE unit_ranks SET is_active = false, updated_at = now() WHERE unit_id = $1 AND id = $2 RETURNING id",
          [unitId, rankId]
        );

        if (!result.rows[0]) {
          return notFound(reply, "rank_not_found", "Battalion rank was not found.");
        }

        await audit(tx, auth.user, "delete_unit_rank", { unit_id: unitId, rank_id: rankId });

        return { ok: true, rank_id: rankId, deleted: true };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to delete unit rank");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/units/:unit_id/squads", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    if (!(await requireUnitMember(auth.user, parsedParams.data.unit_id, reply))) {
      return;
    }

    const result = await queryDb<SquadRow>(
      `
      SELECT id, unit_id, parent_squad_id, squad_key, name, squad_type, hierarchy_mode, sort_order, is_active
      FROM unit_squads
      WHERE unit_id = $1 AND is_active = true
      ORDER BY sort_order, name
      `,
      [parsedParams.data.unit_id]
    );

    return { ok: true, squads: result.rows };
  });

  app.post("/v1/units/:unit_id/squads", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);
    const parsedBody = createSquadBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const unitId = parsedParams.data.unit_id;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const parentSquadId = parsedBody.data.parent_squad_id ?? null;

        if (parentSquadId) {
          const parentResult = await tx.query<{ id: string }>(
            "SELECT id FROM unit_squads WHERE unit_id = $1 AND id = $2 AND is_active = true",
            [unitId, parentSquadId]
          );

          if (!parentResult.rows[0]) {
            return notFound(reply, "parent_squad_not_found", "Parent squad was not found in this battalion.");
          }
        }

        const existingResult = await tx.query<{ id: string; is_active: boolean }>(
          "SELECT id, is_active FROM unit_squads WHERE unit_id = $1 AND squad_key = $2 FOR UPDATE",
          [unitId, parsedBody.data.squad_key]
        );
        const existingSquad = existingResult.rows[0];

        if (existingSquad?.is_active) {
          return conflict(reply, "squad_key_conflict", "An active squad already uses that squad key.");
        }

        if (existingSquad && parentSquadId === existingSquad.id) {
          return sendSquadCycleDetected(reply);
        }

        const result = existingSquad
          ? await tx.query<SquadRow>(
              `
              UPDATE unit_squads
              SET parent_squad_id = $3,
                  name = $4,
                  squad_type = $5,
                  hierarchy_mode = $6,
                  sort_order = $7,
                  is_active = true,
                  updated_at = now()
              WHERE unit_id = $1 AND id = $2
              RETURNING id, unit_id, parent_squad_id, squad_key, name, squad_type, hierarchy_mode, sort_order, is_active
              `,
              [
                unitId,
                existingSquad.id,
                parentSquadId,
                parsedBody.data.name,
                parsedBody.data.squad_type,
                parsedBody.data.hierarchy_mode,
                parsedBody.data.sort_order
              ]
            )
          : await tx.query<SquadRow>(
              `
              INSERT INTO unit_squads (unit_id, parent_squad_id, squad_key, name, squad_type, hierarchy_mode, sort_order)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              RETURNING id, unit_id, parent_squad_id, squad_key, name, squad_type, hierarchy_mode, sort_order, is_active
              `,
              [
                unitId,
                parentSquadId,
                parsedBody.data.squad_key,
                parsedBody.data.name,
                parsedBody.data.squad_type,
                parsedBody.data.hierarchy_mode,
                parsedBody.data.sort_order
              ]
            );

        await audit(tx, auth.user, "create_unit_squad", { unit_id: unitId, squad_id: result.rows[0]?.id });

        return { ok: true, squad: result.rows[0] };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create unit squad");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/units/:unit_id/squads/:squad_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = squadParamsSchema.safeParse(request.params);
    const parsedBody = updateSquadBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId, squad_id: squadId } = parsedParams.data;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const existingResult = await tx.query<SquadRow>(
          `
          SELECT id, unit_id, parent_squad_id, squad_key, name, squad_type, hierarchy_mode, sort_order, is_active
          FROM unit_squads
          WHERE unit_id = $1 AND id = $2 AND is_active = true
          FOR UPDATE
          `,
          [unitId, squadId]
        );
        const existingSquad = existingResult.rows[0];

        if (!existingSquad) {
          return notFound(reply, "squad_not_found", "Battalion squad was not found.");
        }

        const parentSquadId = Object.hasOwn(parsedBody.data, "parent_squad_id") ? parsedBody.data.parent_squad_id ?? null : existingSquad.parent_squad_id;

        if (!(await validateSquadHierarchy(tx, reply, unitId, [{ id: squadId, parent_squad_id: parentSquadId }]))) {
          return;
        }

        const result = await tx.query<SquadRow>(
          `
          UPDATE unit_squads
          SET parent_squad_id = $3,
              squad_key = COALESCE($4, squad_key),
              name = COALESCE($5, name),
              squad_type = COALESCE($6, squad_type),
              hierarchy_mode = COALESCE($7, hierarchy_mode),
              sort_order = COALESCE($8, sort_order),
              is_active = COALESCE($9, is_active),
              updated_at = now()
          WHERE unit_id = $1 AND id = $2
          RETURNING id, unit_id, parent_squad_id, squad_key, name, squad_type, hierarchy_mode, sort_order, is_active
          `,
          [
            unitId,
            squadId,
            parentSquadId,
            parsedBody.data.squad_key ?? null,
            parsedBody.data.name ?? null,
            parsedBody.data.squad_type ?? null,
            parsedBody.data.hierarchy_mode ?? null,
            parsedBody.data.sort_order ?? null,
            parsedBody.data.is_active ?? null
          ]
        );

        await audit(tx, auth.user, "update_unit_squad", { unit_id: unitId, squad_id: squadId });

        return { ok: true, squad: result.rows[0] };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update unit squad");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/units/:unit_id/squads/:squad_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = squadParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { unit_id: unitId, squad_id: squadId } = parsedParams.data;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const result = await tx.query<{ squad_ids: string[]; unassigned_count: number }>(
          `
          WITH RECURSIVE squad_tree AS (
            SELECT id
            FROM unit_squads
            WHERE unit_id = $1 AND id = $2 AND is_active = true

            UNION ALL

            SELECT child.id
            FROM unit_squads child
            JOIN squad_tree parent ON parent.id = child.parent_squad_id
            WHERE child.unit_id = $1 AND child.is_active = true
          ),
          unassigned AS (
            UPDATE unit_roster_assignments
            SET squad_id = NULL,
                billet = 'unassigned',
                updated_at = now()
            WHERE unit_id = $1
              AND squad_id IN (SELECT id FROM squad_tree)
              AND ended_at IS NULL
            RETURNING player_uid
          ),
          deleted AS (
            UPDATE unit_squads
            SET is_active = false,
                parent_squad_id = NULL,
                updated_at = now()
            WHERE unit_id = $1
              AND id IN (SELECT id FROM squad_tree)
            RETURNING id
          )
          SELECT
            ARRAY(SELECT id::text FROM deleted) AS squad_ids,
            (SELECT COUNT(*)::int FROM unassigned) AS unassigned_count
          `,
          [unitId, squadId]
        );

        const deletedSquadIds = result.rows[0]?.squad_ids ?? [];

        if (deletedSquadIds.length === 0) {
          return notFound(reply, "squad_not_found", "Battalion squad was not found.");
        }

        await audit(tx, auth.user, "delete_unit_squad", {
          unit_id: unitId,
          squad_id: squadId,
          deleted_squad_ids: deletedSquadIds,
          unassigned_count: result.rows[0]?.unassigned_count ?? 0
        });

        return {
          ok: true,
          squad_id: squadId,
          deleted_squad_ids: deletedSquadIds,
          unassigned_count: result.rows[0]?.unassigned_count ?? 0,
          deleted: true
        };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to delete unit squad");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/units/:unit_id/squad-layout", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);
    const parsedBody = squadLayoutBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const unitId = parsedParams.data.unit_id;

    if (!(await ensureUnitAdmin(auth.user, unitId, reply))) {
      return;
    }

    try {
      return await withDbTransaction(async (tx) => {
        const squadIds = parsedBody.data.squads.map((squad) => squad.id);
        const parentSquadIds = parsedBody.data.squads.flatMap((squad) => squad.parent_squad_id ? [squad.parent_squad_id] : []);
        const assignmentSquadIds = parsedBody.data.assignments.flatMap((assignment) => assignment.squad_id ? [assignment.squad_id] : []);
        const allSquadIds = Array.from(new Set([...squadIds, ...parentSquadIds, ...assignmentSquadIds]));

        if (allSquadIds.length > 0) {
          const validSquads = await tx.query<{ id: string }>(
            "SELECT id FROM unit_squads WHERE unit_id = $1 AND id = ANY($2::uuid[]) AND is_active = true",
            [unitId, allSquadIds]
          );

          if (validSquads.rows.length !== allSquadIds.length) {
            return sendValidationFailed(reply);
          }
        }

        if (!(await validateSquadHierarchy(tx, reply, unitId, parsedBody.data.squads))) {
          return;
        }

        if (parsedBody.data.assignments.length > 0) {
          const playerUids = parsedBody.data.assignments.map((assignment) => assignment.player_uid);
          const validPlayers = await tx.query<{ player_uid: string }>(
            "SELECT player_uid FROM unit_players WHERE unit_id = $1 AND player_uid = ANY($2::text[]) AND is_active = true",
            [unitId, playerUids]
          );

          if (validPlayers.rows.length !== new Set(playerUids).size) {
            return sendValidationFailed(reply);
          }
        }

        for (const squad of parsedBody.data.squads) {
          await tx.query(
            `
            UPDATE unit_squads
            SET parent_squad_id = $3, sort_order = $4, updated_at = now()
            WHERE unit_id = $1 AND id = $2
            `,
            [unitId, squad.id, squad.parent_squad_id, squad.sort_order]
          );
        }

        for (const assignment of parsedBody.data.assignments) {
          await tx.query(
            `
            UPDATE unit_roster_assignments
            SET ended_at = COALESCE(ended_at, now()), updated_at = now()
            WHERE unit_id = $1
              AND player_uid = $2
              AND ended_at IS NULL
              AND is_primary = true
            `,
            [unitId, assignment.player_uid]
          );
          await tx.query(
            `
            INSERT INTO unit_roster_assignments (
              unit_id,
              player_uid,
              squad_id,
              billet,
              sort_order,
              assigned_by_user_id,
              assignment_source
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'manual')
            `,
            [unitId, assignment.player_uid, assignment.squad_id, assignment.billet, assignment.sort_order, auth.user.id]
          );
        }

        await audit(tx, auth.user, "update_squad_layout", {
          unit_id: unitId,
          squad_count: parsedBody.data.squads.length,
          assignment_count: parsedBody.data.assignments.length
        });

        return { ok: true, unit_id: unitId, updated: true };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update unit squad layout");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/units/:unit_id/admins", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    if (!hasRole(auth.user, ["owner"])) {
      return deny(reply);
    }

    const parsedParams = unitParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const result = await queryDb<AdminRow>(
      `
      SELECT uur.user_id, au.display_name, uur.role, uur.granted_at
      FROM unit_user_roles uur
      JOIN app_users au ON au.id = uur.user_id
      WHERE uur.unit_id = $1
      ORDER BY uur.role, au.display_name NULLS LAST
      `,
      [parsedParams.data.unit_id]
    );

    return { ok: true, admins: result.rows };
  });

  app.put("/v1/units/:unit_id/admins/:user_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    if (!hasRole(auth.user, ["owner"])) {
      return deny(reply);
    }

    const paramsSchema = unitParamsSchema.extend({ user_id: z.string().uuid() });
    const parsedParams = paramsSchema.safeParse(request.params);
    const parsedBody = unitAdminBodySchema.safeParse(request.body ?? {});

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    try {
      return await withDbTransaction(async (tx) => {
        await tx.query(
          `
          INSERT INTO unit_user_roles (unit_id, user_id, role, granted_by_user_id, grant_source)
          VALUES ($1, $2, $3, $4, 'manual')
          ON CONFLICT (unit_id, user_id, role) DO UPDATE
          SET granted_at = now(), granted_by_user_id = EXCLUDED.granted_by_user_id
          `,
          [parsedParams.data.unit_id, parsedParams.data.user_id, parsedBody.data.role, auth.user.id]
        );

        await audit(
          tx,
          auth.user,
          "grant_unit_admin",
          { unit_id: parsedParams.data.unit_id, role: parsedBody.data.role },
          parsedParams.data.user_id
        );

        return { ok: true, unit_id: parsedParams.data.unit_id, user_id: parsedParams.data.user_id, role: parsedBody.data.role };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to grant unit admin");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/units/:unit_id/admins/:user_id", async (request, reply) => {
    const auth = await getAuthContext(request, reply);

    if (!auth || !auth.user) {
      return;
    }

    if (!hasRole(auth.user, ["owner"])) {
      return deny(reply);
    }

    const paramsSchema = unitParamsSchema.extend({ user_id: z.string().uuid() });
    const parsedParams = paramsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      return await withDbTransaction(async (tx) => {
        await tx.query("DELETE FROM unit_user_roles WHERE unit_id = $1 AND user_id = $2 AND role IN ('officer', 'admin', 'tcw_admin')", [
          parsedParams.data.unit_id,
          parsedParams.data.user_id
        ]);

        await audit(tx, auth.user, "revoke_unit_admin", { unit_id: parsedParams.data.unit_id }, parsedParams.data.user_id);

        return { ok: true, unit_id: parsedParams.data.unit_id, user_id: parsedParams.data.user_id, revoked: true };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to revoke unit admin");
      return sendDatabaseUnavailable(reply);
    }
  });
}
