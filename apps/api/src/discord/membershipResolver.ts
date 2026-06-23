import { config } from "../config.js";
import { getDiscordAuthPolicy } from "../config/discordAuth.js";
import { queryDb } from "../db/pool.js";
import { ensureDiscordPlaceholderPlayerForReconcile } from "./playerAssignment.js";

export type DiscordRoleClaimType =
  | "unit_primary"
  | "unit_secondary"
  | "rank"
  | "unit_role"
  | "app_role"
  | "roster_status"
  | "deny_login";

export type DiscordRoleClaim = {
  claimType: DiscordRoleClaimType;
  guildId: string;
  roleId: string;
  roleName: string | null;
  unitId: string | null;
  rankId: string | null;
  unitRole: string | null;
  appRole: string | null;
  rosterStatus: string | null;
  guildPriority: number;
  mappingPriority: number;
  rolePosition: number;
  configOrder: number;
  guildType: string;
};

type ClaimRow = {
  claim_type: DiscordRoleClaimType;
  guild_id: string;
  role_id: string;
  role_name: string | null;
  unit_id: string | null;
  rank_id: string | null;
  unit_role: string | null;
  app_role: string | null;
  roster_status: string | null;
  unit_priority: number;
  rank_priority: number;
  permission_priority: number;
  mapping_priority: number;
  role_position: number | null;
  config_order: number;
  guild_type: string;
};

type PlayerIdentityRow = {
  user_id: string | null;
  player_uid: string | null;
  discord_user_id: string | null;
};

type CurrentUnitPlayerRow = {
  unit_id: string;
  rank_id: string | null;
  roster_status: string;
  assignment_locked: boolean;
  assignment_source: string;
  assignment_priority: number;
};

type UnitMembershipClaimSet = {
  unitId: string;
  membershipKind: "primary" | "secondary";
  assignmentClaim: DiscordRoleClaim;
  rankClaim: DiscordRoleClaim | null;
  rosterStatusClaim: DiscordRoleClaim | null;
  unitRoleClaims: DiscordRoleClaim[];
  assignmentPriority: number;
};

export type DiscordMemberSnapshotInput = {
  guildId: string;
  discordUserId: string;
  userId?: string | null;
  roles: string[];
  nick?: string | null;
  joinedAt?: string | null;
  rawMember?: Record<string, unknown>;
  source: "oauth_login" | "oauth_refresh" | "oauth_refresh_absent" | "bot_snapshot" | "bot_event" | "manual_import";
};

export type ReconcileDiscordMembershipOptions = {
  userId?: string;
  discordUserId?: string;
  guildId?: string;
  dryRun?: boolean;
  source?: string;
};

export type ReconcileDiscordMembershipResult = {
  ok: true;
  dry_run: boolean;
  user_id: string | null;
  discord_user_id: string | null;
  player_uid: string | null;
  denied: boolean;
  manual_locked: boolean;
  winning_claims: {
    unit_primary: DiscordRoleClaim | null;
    unit_memberships: Array<{
      unit_id: string;
      membership_kind: "primary" | "secondary";
      assignment_claim: DiscordRoleClaim;
      rank: DiscordRoleClaim | null;
      roster_status: DiscordRoleClaim | null;
    }>;
    rank: DiscordRoleClaim | null;
    roster_status: DiscordRoleClaim | null;
    unit_roles: DiscordRoleClaim[];
    app_roles: DiscordRoleClaim[];
  };
  ignored_claims: Array<DiscordRoleClaim & { reason: string }>;
  applied: string[];
  represented_unit_id?: string | null;
  deactivated_unit_ids?: string[];
};

const allowedAppRoles = new Set(["viewer", "officer", "admin", "tcw_admin", "owner"]);
const globalAdminRoles = new Set(["admin", "tcw_admin", "owner"]);
const allowedUnitRoles = new Set(["member", "officer", "admin", "tcw_admin"]);
const unitUserRoleGrantRoles = new Set(["officer", "admin", "tcw_admin"]);
const unitMembershipGrantRoles = new Set(["member", "officer", "admin"]);

export async function syncDiscordAuthPolicyToDb(): Promise<number> {
  const policy = getDiscordAuthPolicy();

  for (const guild of policy.guilds) {
    await queryDb(
      `
      INSERT INTO discord_guilds (
        guild_id,
        name,
        guild_type,
        grants_login,
        sync_members,
        is_fallback,
        unit_priority,
        rank_priority,
        permission_priority,
        config_order,
        config_source,
        last_config_loaded_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'file', now())
      ON CONFLICT (guild_id) DO UPDATE
      SET
        name = COALESCE(discord_guilds.name, EXCLUDED.name),
        guild_type = EXCLUDED.guild_type,
        grants_login = EXCLUDED.grants_login,
        sync_members = EXCLUDED.sync_members,
        is_fallback = EXCLUDED.is_fallback,
        unit_priority = EXCLUDED.unit_priority,
        rank_priority = EXCLUDED.rank_priority,
        permission_priority = EXCLUDED.permission_priority,
        config_order = EXCLUDED.config_order,
        config_source = EXCLUDED.config_source,
        last_config_loaded_at = now(),
        updated_at = now()
      `,
      [
        guild.guildId,
        guild.label ?? guild.guildId,
        guild.type,
        guild.grantsLogin,
        guild.syncMembers,
        guild.fallback,
        guild.unitPriority,
        guild.rankPriority,
        guild.permissionPriority,
        guild.configOrder
      ]
    );
  }

  return policy.guilds.length;
}

export async function getLoginGrantGuildIdsFromDb(): Promise<string[]> {
  const result = await queryDb<{ guild_id: string }>(
    `
    SELECT guild_id
    FROM discord_guilds
    WHERE grants_login = true
    ORDER BY unit_priority DESC, rank_priority DESC, permission_priority DESC, config_order ASC, name ASC
    `
  );

  return result.rows.map((row) => row.guild_id);
}

export async function upsertDiscordMemberSnapshot(input: DiscordMemberSnapshotInput): Promise<void> {
  const joinedAt = input.joinedAt ? new Date(input.joinedAt) : null;
  await queryDb(
    `
    INSERT INTO discord_member_snapshots (
      guild_id,
      discord_user_id,
      user_id,
      role_ids,
      nick,
      joined_at,
      member_payload,
      source,
      last_seen_at
    )
    VALUES (
      $1,
      $2,
      COALESCE(
        $3::uuid,
        (SELECT user_id FROM user_identities WHERE provider = 'discord' AND provider_user_id = $2 ORDER BY last_seen_at DESC LIMIT 1)
      ),
      $4::jsonb,
      $5,
      $6,
      $7::jsonb,
      $8,
      now()
    )
    ON CONFLICT (guild_id, discord_user_id) DO UPDATE
    SET
      user_id = COALESCE(EXCLUDED.user_id, discord_member_snapshots.user_id),
      role_ids = EXCLUDED.role_ids,
      nick = EXCLUDED.nick,
      joined_at = EXCLUDED.joined_at,
      member_payload = EXCLUDED.member_payload,
      source = EXCLUDED.source,
      last_seen_at = now(),
      last_error = null,
      updated_at = now()
    `,
    [
      input.guildId,
      input.discordUserId,
      input.userId ?? null,
      JSON.stringify(input.roles),
      input.nick ?? null,
      joinedAt,
      JSON.stringify(input.rawMember ?? {}),
      input.source
    ]
  );
}

function claimFromRow(row: ClaimRow): DiscordRoleClaim {
  const guildPriority =
    row.claim_type === "rank"
      ? row.rank_priority
      : row.claim_type === "app_role"
        ? row.permission_priority
        : row.unit_priority;

  return {
    claimType: row.claim_type,
    guildId: row.guild_id,
    roleId: row.role_id,
    roleName: row.role_name,
    unitId: row.unit_id,
    rankId: row.rank_id,
    unitRole: row.unit_role,
    appRole: row.app_role,
    rosterStatus: row.roster_status,
    guildPriority,
    mappingPriority: row.mapping_priority,
    rolePosition: row.role_position ?? 0,
    configOrder: row.config_order,
    guildType: row.guild_type
  };
}

function compareClaims(a: DiscordRoleClaim, b: DiscordRoleClaim): number {
  return (
    b.guildPriority - a.guildPriority ||
    b.mappingPriority - a.mappingPriority ||
    b.rolePosition - a.rolePosition ||
    a.configOrder - b.configOrder
  );
}

function pickWinner(claims: DiscordRoleClaim[]): DiscordRoleClaim | null {
  return [...claims].sort(compareClaims)[0] ?? null;
}

function ignoredClaims(claims: DiscordRoleClaim[], winner: DiscordRoleClaim | null, reason: string) {
  return claims
    .filter((claim) => !winner || claim.guildId !== winner.guildId || claim.roleId !== winner.roleId || claim.claimType !== winner.claimType)
    .map((claim) => ({ ...claim, reason }));
}

function filterAppRoleClaims(claims: DiscordRoleClaim[]): DiscordRoleClaim[] {
  const policy = getDiscordAuthPolicy();
  const partnerMayGrantGlobalAdmin = policy.permissions.partnerGuildsMayGrantGlobalAdmin;

  return claims.filter((claim) => {
    if (!claim.appRole || !allowedAppRoles.has(claim.appRole)) {
      return false;
    }

    if (!partnerMayGrantGlobalAdmin && claim.guildType !== "fallback" && globalAdminRoles.has(claim.appRole)) {
      return false;
    }

    return true;
  });
}

async function findIdentity(options: ReconcileDiscordMembershipOptions): Promise<PlayerIdentityRow> {
  const result = await queryDb<PlayerIdentityRow>(
    `
    WITH supplied AS (
      SELECT $1::uuid AS user_id, $2::text AS discord_user_id
    ),
    selected_identity AS (
      SELECT
        COALESCE(s.discord_user_id, ui.provider_user_id) AS discord_user_id,
        COALESCE(s.user_id, ui.user_id) AS user_id
      FROM supplied s
      LEFT JOIN LATERAL (
        SELECT user_id, provider_user_id
        FROM user_identities
        WHERE provider = 'discord'
          AND (s.user_id IS NULL OR user_id = s.user_id)
          AND (s.discord_user_id IS NULL OR provider_user_id = s.discord_user_id)
        ORDER BY last_seen_at DESC
        LIMIT 1
      ) ui ON true
      WHERE s.user_id IS NOT NULL OR s.discord_user_id IS NOT NULL OR ui.user_id IS NOT NULL
    ),
    chosen_player AS (
      SELECT ui.provider_user_id AS player_uid, 0 AS priority
      FROM selected_identity si
      JOIN user_identities ui ON ui.user_id = si.user_id AND ui.provider = 'steam'
      UNION ALL
      SELECT pdl.player_uid, 1 AS priority
      FROM selected_identity si
      JOIN player_discord_links pdl ON pdl.discord_user_id = si.discord_user_id
      UNION ALL
      SELECT 'discord:' || si.discord_user_id, 2 AS priority
      FROM selected_identity si
      WHERE si.discord_user_id IS NOT NULL
    )
    SELECT
      (SELECT user_id::text FROM selected_identity LIMIT 1) AS user_id,
      (SELECT player_uid FROM chosen_player ORDER BY priority LIMIT 1) AS player_uid,
      (SELECT discord_user_id FROM selected_identity LIMIT 1) AS discord_user_id
    `,
    [options.userId ?? null, options.discordUserId ?? null]
  );

  return result.rows[0] ?? { user_id: options.userId ?? null, player_uid: null, discord_user_id: options.discordUserId ?? null };
}

async function loadClaims(options: ReconcileDiscordMembershipOptions, discordUserId: string | null): Promise<DiscordRoleClaim[]> {
  const result = await queryDb<ClaimRow>(
    `
    SELECT
      drm.mapping_type AS claim_type,
      drm.guild_id,
      drm.role_id,
      dr.name AS role_name,
      drm.unit_id::text,
      drm.rank_id::text,
      drm.unit_role,
      drm.app_role,
      drm.roster_status,
      dg.unit_priority,
      dg.rank_priority,
      dg.permission_priority,
      drm.priority AS mapping_priority,
      dr.position AS role_position,
      dg.config_order,
      dg.guild_type
    FROM discord_member_snapshots dms
    JOIN LATERAL jsonb_array_elements_text(dms.role_ids) snapshot_role(role_id) ON true
    JOIN discord_role_mappings drm
      ON drm.guild_id = dms.guild_id
      AND drm.role_id = snapshot_role.role_id
      AND drm.is_enabled = true
    LEFT JOIN discord_roles dr
      ON dr.guild_id = drm.guild_id
      AND dr.role_id = drm.role_id
    JOIN discord_guilds dg ON dg.guild_id = dms.guild_id
    WHERE ($1::uuid IS NULL OR dms.user_id = $1::uuid)
      AND ($2::text IS NULL OR dms.discord_user_id = $2::text)
      AND ($3::text IS NULL OR dms.guild_id = $3::text)
    `,
    [options.userId ?? null, discordUserId ?? options.discordUserId ?? null, options.guildId ?? null]
  );

  return result.rows.map(claimFromRow);
}

async function currentUnitRows(playerUid: string): Promise<CurrentUnitPlayerRow[]> {
  const result = await queryDb<CurrentUnitPlayerRow>(
    `
    SELECT unit_id::text, rank_id::text, roster_status, assignment_locked, assignment_source, assignment_priority
    FROM unit_players
    WHERE player_uid = $1
      AND is_active = true
      AND roster_status <> 'inactive'
    `,
    [playerUid]
  );

  return result.rows;
}

function pickUnitSpecificWinner(claims: DiscordRoleClaim[], unitId: string): DiscordRoleClaim | null {
  return [...claims]
    .filter((claim) => !claim.unitId || claim.unitId === unitId)
    .sort((a, b) => {
      const specificity = (b.unitId === unitId ? 1 : 0) - (a.unitId === unitId ? 1 : 0);
      return specificity || compareClaims(a, b);
    })[0] ?? null;
}

function buildUnitMembershipClaimSets(
  assignmentClaims: DiscordRoleClaim[],
  rankClaims: DiscordRoleClaim[],
  rosterStatusClaims: DiscordRoleClaim[],
  unitRoleClaims: DiscordRoleClaim[]
): UnitMembershipClaimSet[] {
  const byUnit = new Map<string, DiscordRoleClaim[]>();

  for (const claim of assignmentClaims) {
    if (!claim.unitId) {
      continue;
    }

    const claims = byUnit.get(claim.unitId) ?? [];
    claims.push(claim);
    byUnit.set(claim.unitId, claims);
  }

  return Array.from(byUnit.entries())
    .map(([unitId, claims]) => {
      const primaryWinner = pickWinner(claims.filter((claim) => claim.claimType === "unit_primary"));
      const assignmentClaim = primaryWinner ?? pickWinner(claims.filter((claim) => claim.claimType === "unit_secondary"));

      if (!assignmentClaim) {
        return null;
      }

      return {
        unitId,
        membershipKind: primaryWinner ? "primary" as const : "secondary" as const,
        assignmentClaim,
        rankClaim: pickUnitSpecificWinner(rankClaims, unitId),
        rosterStatusClaim: pickUnitSpecificWinner(rosterStatusClaims, unitId),
        unitRoleClaims: unitRoleClaims.filter((claim) => claim.unitId === unitId),
        assignmentPriority: assignmentClaim.guildPriority
      };
    })
    .filter((claimSet): claimSet is UnitMembershipClaimSet => claimSet !== null)
    .sort((a, b) => compareClaims(a.assignmentClaim, b.assignmentClaim));
}

function serializeUnitMembershipClaimSet(claimSet: UnitMembershipClaimSet) {
  return {
    unit_id: claimSet.unitId,
    membership_kind: claimSet.membershipKind,
    assignment_claim: claimSet.assignmentClaim,
    rank: claimSet.rankClaim,
    roster_status: claimSet.rosterStatusClaim
  };
}

async function deactivateDiscordGrantsForDeniedIdentity(
  targetUserId: string | null,
  playerUid: string | null
): Promise<string[]> {
  if (targetUserId) {
    await queryDb("DELETE FROM unit_user_roles WHERE user_id = $1 AND grant_source = 'discord'", [targetUserId]);
    await queryDb("DELETE FROM unit_memberships WHERE user_id = $1 AND grant_source = 'discord'", [targetUserId]);
    await queryDb("DELETE FROM user_roles WHERE user_id = $1 AND grant_source = 'discord'", [targetUserId]);
  }

  if (!playerUid) {
    return [];
  }

  const result = await queryDb<{ unit_id: string }>(
    `
    UPDATE unit_players
    SET is_active = false,
        roster_status = 'inactive',
        left_unit_at = COALESCE(left_unit_at, now()),
        updated_at = now()
    WHERE player_uid = $1
      AND assignment_source = 'discord'
      AND assignment_locked = false
      AND is_active = true
    RETURNING unit_id::text
    `,
    [playerUid]
  );

  return result.rows.map((row) => row.unit_id);
}

async function applyDiscordUnitMemberships(
  playerUid: string,
  discordUserId: string,
  claimSets: UnitMembershipClaimSet[],
  source: string
): Promise<{ manualLocked: boolean; deactivatedUnitIds: string[]; applied: string[] }> {
  if (playerUid === `discord:${discordUserId}`) {
    await ensureDiscordPlaceholderPlayerForReconcile({
      playerUid,
      discordUserId,
      createPlayerIfMissing: true,
      rawMember: {
        source: "discord_reconcile",
        discord_user_id: discordUserId
      }
    });
  }

  const currentRows = await currentUnitRows(playerUid);
  const manualLocked = currentRows.some((row) => row.assignment_locked);
  const claimedUnitIds = new Set(claimSets.map((claimSet) => claimSet.unitId));
  const applied: string[] = [];

  for (const claimSet of claimSets) {
    await queryDb(
      `
      INSERT INTO unit_players (
        unit_id,
        player_uid,
        roster_status,
        assignment_source,
        assignment_priority,
        source_guild_id,
        source_role_id,
        rank_id,
        is_active,
        joined_unit_at
      )
      VALUES ($1::uuid, $2, COALESCE($3, 'active'), 'discord', $4, $5, $6, $7::uuid, true, now())
      ON CONFLICT (unit_id, player_uid) DO UPDATE
      SET
        roster_status = COALESCE(EXCLUDED.roster_status, unit_players.roster_status),
        assignment_source = 'discord',
        assignment_priority = EXCLUDED.assignment_priority,
        source_guild_id = EXCLUDED.source_guild_id,
        source_role_id = EXCLUDED.source_role_id,
        rank_id = COALESCE(EXCLUDED.rank_id, unit_players.rank_id),
        is_active = true,
        left_unit_at = null,
        updated_at = now()
      WHERE unit_players.assignment_locked = false
        AND unit_players.assignment_source <> 'manual'
      `,
      [
        claimSet.unitId,
        playerUid,
        claimSet.rosterStatusClaim?.rosterStatus ?? null,
        claimSet.assignmentPriority,
        claimSet.assignmentClaim.guildId,
        claimSet.assignmentClaim.roleId,
        claimSet.rankClaim?.rankId ?? null
      ]
    );
    applied.push(claimSet.membershipKind === "primary" ? "unit_primary" : "unit_secondary");
    await auditChange(
      null,
      playerUid,
      discordUserId,
      "apply",
      claimSet.membershipKind === "primary" ? "unit_primary" : "unit_secondary",
      currentRows.find((row) => row.unit_id === claimSet.unitId) ?? null,
      { unit_id: claimSet.unitId, rank_id: claimSet.rankClaim?.rankId ?? null },
      claimSet.assignmentClaim,
      [],
      source
    );
  }

  const staleParams: unknown[] = [playerUid];
  const staleUnitFilter =
    claimedUnitIds.size > 0
      ? `AND unit_id <> ALL($2::uuid[])`
      : "AND assignment_source = 'discord'";

  if (claimedUnitIds.size > 0) {
    staleParams.push(Array.from(claimedUnitIds));
  }

  const staleResult = await queryDb<{ unit_id: string }>(
    `
    UPDATE unit_players
    SET is_active = false,
        roster_status = 'inactive',
        left_unit_at = COALESCE(left_unit_at, now()),
        updated_at = now()
    WHERE player_uid = $1
      AND assignment_source IN ('discord', 'auth-default')
      AND assignment_locked = false
      AND is_active = true
      ${staleUnitFilter}
    RETURNING unit_id::text
    `,
    staleParams
  );

  return {
    manualLocked,
    deactivatedUnitIds: staleResult.rows.map((row) => row.unit_id),
    applied
  };
}

async function repairRepresentedUnitPreference(input: {
  playerUid: string;
  preferredUnitId: string | null;
  actorUserId: string | null;
  source: string;
}): Promise<{ changed: boolean; represented_unit_id: string | null }> {
  const activeResult = await queryDb<{ unit_id: string; assignment_priority: number }>(
    `
    SELECT unit_id::text, assignment_priority
    FROM unit_players
    WHERE player_uid = $1
      AND is_active = true
      AND roster_status <> 'inactive'
    ORDER BY assignment_priority DESC, updated_at DESC, unit_id
    `,
    [input.playerUid]
  );
  const activeUnitIds = new Set(activeResult.rows.map((row) => row.unit_id));
  const preferenceResult = await queryDb<{ represented_unit_id: string | null }>(
    "SELECT represented_unit_id::text FROM player_unit_preferences WHERE player_uid = $1",
    [input.playerUid]
  );
  const current = preferenceResult.rows[0]?.represented_unit_id ?? null;

  if (current && activeUnitIds.has(current)) {
    return { changed: false, represented_unit_id: current };
  }

  const next = input.preferredUnitId && activeUnitIds.has(input.preferredUnitId)
    ? input.preferredUnitId
    : (activeResult.rows[0]?.unit_id ?? null);

  await queryDb(
    `
    INSERT INTO player_unit_preferences (player_uid, represented_unit_id, updated_by_user_id)
    VALUES ($1, $2::uuid, $3::uuid)
    ON CONFLICT (player_uid) DO UPDATE
    SET represented_unit_id = EXCLUDED.represented_unit_id,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
    `,
    [input.playerUid, next, input.actorUserId]
  );

  if (current !== next) {
    await queryDb(
      `
      INSERT INTO admin_audit_events (actor_user_id, actor_label, action, details)
      VALUES ($1::uuid, $2, 'repair_represented_unit', $3::jsonb)
      `,
      [
        input.actorUserId,
        input.source,
        JSON.stringify({
          player_uid: input.playerUid,
          previous_unit_id: current,
          represented_unit_id: next
        })
      ]
    );
  }

  return { changed: current !== next, represented_unit_id: next };
}

async function auditChange(
  userId: string | null,
  playerUid: string | null,
  discordUserId: string | null,
  action: string,
  field: string,
  previousValue: unknown,
  nextValue: unknown,
  winningClaim: DiscordRoleClaim | null,
  ignored: Array<DiscordRoleClaim & { reason: string }>,
  source: string
) {
  await queryDb(
    `
    INSERT INTO discord_assignment_audits (
      user_id,
      player_uid,
      discord_user_id,
      action,
      field,
      previous_value,
      next_value,
      winning_claim,
      ignored_claims,
      source
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
    `,
    [
      userId,
      playerUid,
      discordUserId,
      action,
      field,
      JSON.stringify(previousValue ?? null),
      JSON.stringify(nextValue ?? null),
      JSON.stringify(winningClaim ?? null),
      JSON.stringify(ignored),
      source
    ]
  );
}

export async function reconcileDiscordMembership(
  options: ReconcileDiscordMembershipOptions
): Promise<ReconcileDiscordMembershipResult> {
  const dryRun = options.dryRun ?? true;
  const source = options.source ?? "discord_reconcile";
  const identity = await findIdentity(options);
  const targetUserId = options.userId ?? identity.user_id;
  const claims = await loadClaims(options, identity.discord_user_id);
  const denyClaims = claims.filter((claim) => claim.claimType === "deny_login");
  const assignmentClaims = claims.filter(
    (claim) => (claim.claimType === "unit_primary" || claim.claimType === "unit_secondary") && claim.unitId
  );
  const rankClaims = claims.filter((claim) => claim.claimType === "rank" && claim.rankId);
  const rosterStatusClaims = claims.filter((claim) => claim.claimType === "roster_status" && claim.rosterStatus);
  const unitRoleClaims = claims
    .filter((claim) => claim.claimType === "unit_role" && claim.unitId && claim.unitRole && allowedUnitRoles.has(claim.unitRole))
    .sort(compareClaims);
  const appRoleClaims = filterAppRoleClaims(claims.filter((claim) => claim.claimType === "app_role")).sort(compareClaims);
  const unitMembershipClaimSets = buildUnitMembershipClaimSets(assignmentClaims, rankClaims, rosterStatusClaims, unitRoleClaims);
  const unitWinner =
    pickWinner(unitMembershipClaimSets.filter((claimSet) => claimSet.membershipKind === "primary").map((claimSet) => claimSet.assignmentClaim)) ??
    pickWinner(unitMembershipClaimSets.map((claimSet) => claimSet.assignmentClaim));
  const representedWinner =
    unitMembershipClaimSets.find((claimSet) => claimSet.assignmentClaim === unitWinner) ??
    unitMembershipClaimSets[0] ??
    null;
  const rankWinner = representedWinner?.rankClaim ?? pickWinner(rankClaims);
  const rosterStatusWinner = representedWinner?.rosterStatusClaim ?? pickWinner(rosterStatusClaims);
  const ignored = [
    ...ignoredClaims(assignmentClaims, unitWinner, "lower unit priority"),
    ...ignoredClaims(rankClaims, rankWinner, "lower rank priority"),
    ...ignoredClaims(rosterStatusClaims, rosterStatusWinner, "lower roster status priority")
  ];
  const applied: string[] = [];
  let manualLocked = false;
  let representedUnitId: string | null = null;
  let deactivatedUnitIds: string[] = [];
  const denyWinner = pickWinner(denyClaims);

  if (denyWinner) {
    if (!dryRun) {
      deactivatedUnitIds = await deactivateDiscordGrantsForDeniedIdentity(targetUserId ?? null, identity.player_uid);
      applied.push("discord_grants_revoked");
      await auditChange(
        targetUserId ?? null,
        identity.player_uid,
        identity.discord_user_id,
        "deny",
        "login",
        null,
        { denied: true },
        denyWinner,
        ignoredClaims(denyClaims, denyWinner, "lower deny priority"),
        source
      );
    }

    return {
      ok: true,
      dry_run: dryRun,
      user_id: targetUserId ?? null,
      discord_user_id: identity.discord_user_id,
      player_uid: identity.player_uid,
      denied: true,
      manual_locked: false,
      winning_claims: {
        unit_primary: null,
        unit_memberships: [],
        rank: null,
        roster_status: null,
        unit_roles: [],
        app_roles: []
      },
      ignored_claims: [
        ...ignoredClaims(denyClaims, denyWinner, "lower deny priority"),
        ...claims.filter((claim) => claim.claimType !== "deny_login").map((claim) => ({ ...claim, reason: "login denied" }))
      ],
      applied,
      represented_unit_id: null,
      deactivated_unit_ids: deactivatedUnitIds
    };
  }

  if (!dryRun && identity.player_uid && identity.discord_user_id) {
    const unitApplyResult = await applyDiscordUnitMemberships(identity.player_uid, identity.discord_user_id, unitMembershipClaimSets, source);
    manualLocked = unitApplyResult.manualLocked;
    deactivatedUnitIds = unitApplyResult.deactivatedUnitIds;
    applied.push(...unitApplyResult.applied);
  }

  if (!dryRun && targetUserId) {
    const unitRoleRows = [
      ...unitMembershipClaimSets.map((claimSet) => ({
        unit_id: claimSet.unitId,
        role: "member",
        claim: claimSet.assignmentClaim
      })),
      ...unitRoleClaims.map((claim) => ({
        unit_id: claim.unitId,
        role: claim.unitRole,
        claim
      }))
    ].filter((row): row is { unit_id: string; role: string; claim: DiscordRoleClaim } => Boolean(row.unit_id && row.role));
    await queryDb("DELETE FROM unit_user_roles WHERE user_id = $1 AND grant_source = 'discord'", [targetUserId]);
    await queryDb("DELETE FROM unit_memberships WHERE user_id = $1 AND grant_source = 'discord'", [targetUserId]);
    for (const row of unitRoleRows) {
      if (unitUserRoleGrantRoles.has(row.role)) {
        await queryDb(
          `
          INSERT INTO unit_user_roles (unit_id, user_id, role, grant_source)
          VALUES ($1::uuid, $2::uuid, $3, 'discord')
          ON CONFLICT (unit_id, user_id, role) DO UPDATE SET grant_source = 'discord'
          `,
          [row.unit_id, targetUserId, row.role]
        );
      }

      if (unitMembershipGrantRoles.has(row.role)) {
        await queryDb(
          `
          INSERT INTO unit_memberships (unit_id, user_id, role, grant_source)
          VALUES ($1::uuid, $2::uuid, $3, 'discord')
          ON CONFLICT (unit_id, user_id, role) DO UPDATE SET grant_source = 'discord', updated_at = now()
          `,
          [row.unit_id, targetUserId, row.role]
        );
      }
    }

    await queryDb("DELETE FROM user_roles WHERE user_id = $1 AND grant_source = 'discord'", [targetUserId]);
    for (const claim of appRoleClaims) {
      await queryDb(
        `
        INSERT INTO user_roles (user_id, role, grant_source)
        VALUES ($1::uuid, $2, 'discord')
        ON CONFLICT (user_id, role) DO UPDATE SET grant_source = 'discord'
        `,
        [targetUserId, claim.appRole]
      );
    }

    if (unitRoleRows.length > 0) {
      applied.push("unit_roles");
    }
    if (appRoleClaims.length > 0) {
      applied.push("app_roles");
    }
  }

  if (!dryRun && identity.player_uid) {
    const repaired = await repairRepresentedUnitPreference({
      playerUid: identity.player_uid,
      preferredUnitId: representedWinner?.unitId ?? null,
      actorUserId: targetUserId ?? null,
      source: `system/${source}`
    });
    representedUnitId = repaired.represented_unit_id;

    if (repaired.changed) {
      applied.push("represented_unit_repaired");
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    user_id: targetUserId ?? null,
    discord_user_id: identity.discord_user_id,
    player_uid: identity.player_uid,
    denied: denyClaims.length > 0,
    manual_locked: manualLocked,
    winning_claims: {
      unit_primary: unitWinner,
      unit_memberships: unitMembershipClaimSets.map(serializeUnitMembershipClaimSet),
      rank: rankWinner,
      roster_status: rosterStatusWinner,
      unit_roles: unitRoleClaims,
      app_roles: appRoleClaims
    },
    ignored_claims: ignored,
    applied,
    represented_unit_id: representedUnitId,
    deactivated_unit_ids: deactivatedUnitIds
  };
}

export function discordAuthRequiresGuild(): boolean {
  return config.discordAuthEnabled && config.discordAuthRequireGuild;
}
