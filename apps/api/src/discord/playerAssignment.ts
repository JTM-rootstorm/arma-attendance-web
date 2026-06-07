import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { getDrizzleDb } from "../db/drizzle.js";
import { discordAssignmentAudits, playerDiscordLinks } from "../db/schema/discord.js";
import { players } from "../db/schema/players.js";
import { unitPlayers, units } from "../db/schema/units.js";

type DrizzleDb = ReturnType<typeof getDrizzleDb>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

type RosterStatus = "active" | "reserve" | "loa" | "inactive";
type IdentifierUsed = "player_uid" | "discord_user_id";

type PlayerRow = {
  player_uid: string;
  last_name: string | null;
};

type UnitRow = {
  id: string;
  unit_key: string;
};

type LinkRow = {
  player_uid: string;
  discord_user_id: string;
  discord_username: string | null;
  discord_display_name: string | null;
  source: string;
  verified_at: Date | null;
};

type AssignmentRow = {
  unit_id: string;
  player_uid: string;
  rank: string | null;
  roster_name: string | null;
  is_active: boolean;
  roster_status: string;
  assignment_source: string;
  assignment_priority: number;
  rank_id: string | null;
  source_guild_id: string | null;
  source_role_id: string | null;
};

type LockedAssignmentRow = {
  unit_id: string;
  roster_status: string;
  assignment_source: string;
};

export type ResolveDiscordPlayerInput = {
  playerUid?: string | undefined;
  discordUserId?: string | undefined;
  guildId?: string | null | undefined;
  roleId?: string | null | undefined;
  discordUsername?: string | null | undefined;
  discordDisplayName?: string | null | undefined;
  nick?: string | null | undefined;
  rosterName?: string | null | undefined;
  createPlayerIfMissing?: boolean | undefined;
  rawMember?: Record<string, unknown> | undefined;
};

export type ResolvedDiscordPlayer = {
  player_uid: string;
  last_name: string | null;
  identifier_used: IdentifierUsed;
  created_player: boolean;
  created_link: boolean;
  would_create_player: boolean;
  would_create_link: boolean;
  link: LinkRow | null;
};

export type DiscordBotUnitAssignmentInput = ResolveDiscordPlayerInput & {
  unitId?: string | undefined;
  unitKey?: string | undefined;
  rankId?: string | null | undefined;
  rank?: string | null | undefined;
  rosterStatus?: RosterStatus | undefined;
  isActive?: boolean | undefined;
  assignmentPriority?: number | undefined;
  dryRun?: boolean | undefined;
};

export type DiscordBotUnitAssignmentResult =
  | {
      ok: true;
      dry_run: boolean;
      identifier_used: IdentifierUsed;
      created_player: boolean;
      created_link: boolean;
      player: PlayerRow;
      link: LinkRow | null;
      assignment: AssignmentRow;
      audits_written: number;
    }
  | {
      ok: true;
      dry_run: true;
      identifier_used: IdentifierUsed;
      would_create_player: boolean;
      would_create_link: boolean;
      would_assign: boolean;
      resolved_player_uid: string;
      unit_id: string;
    }
  | {
      ok: false;
      code: "assignment_locked";
      message: string;
      player_uid: string;
      locked_assignment: LockedAssignmentRow;
      audits_written: number;
    };

export class DiscordPlayerAssignmentError extends Error {
  readonly code: "unit_not_found" | "player_not_found";
  readonly statusCode: number;

  constructor(code: "unit_not_found" | "player_not_found", message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function displayNameFor(input: ResolveDiscordPlayerInput, playerUid: string): string {
  return (
    input.discordDisplayName?.trim() ||
    input.discordUsername?.trim() ||
    input.nick?.trim() ||
    input.rosterName?.trim() ||
    (input.discordUserId ? `Discord ${input.discordUserId}` : playerUid)
  );
}

function placeholderUid(discordUserId: string): string {
  return `discord:${discordUserId}`;
}

const assignmentReturning = {
  unit_id: sql<string>`${unitPlayers.unitId}::text`,
  player_uid: unitPlayers.playerUid,
  rank: unitPlayers.rank,
  roster_name: unitPlayers.rosterName,
  is_active: unitPlayers.isActive,
  roster_status: unitPlayers.rosterStatus,
  assignment_source: unitPlayers.assignmentSource,
  assignment_priority: unitPlayers.assignmentPriority,
  rank_id: sql<string | null>`${unitPlayers.rankId}::text`,
  source_guild_id: unitPlayers.sourceGuildId,
  source_role_id: unitPlayers.sourceRoleId
};

const linkReturning = {
  player_uid: playerDiscordLinks.playerUid,
  discord_user_id: playerDiscordLinks.discordUserId,
  discord_username: playerDiscordLinks.discordUsername,
  discord_display_name: playerDiscordLinks.discordDisplayName,
  source: playerDiscordLinks.source,
  verified_at: playerDiscordLinks.verifiedAt
};

async function findPlayer(tx: DrizzleTransaction, playerUid: string): Promise<PlayerRow | null> {
  const rows = await tx
    .select({
      player_uid: players.playerUid,
      last_name: players.lastName
    })
    .from(players)
    .where(and(eq(players.playerUid, playerUid), isNull(players.deletedAt)))
    .limit(1);

  return rows[0] ?? null;
}

async function findLink(tx: DrizzleTransaction, discordUserId: string): Promise<LinkRow | null> {
  const rows = await tx
    .select(linkReturning)
    .from(playerDiscordLinks)
    .where(eq(playerDiscordLinks.discordUserId, discordUserId))
    .limit(1);

  return rows[0] ?? null;
}

async function upsertPlayer(tx: DrizzleTransaction, playerUid: string, displayName: string, input: ResolveDiscordPlayerInput): Promise<void> {
  await tx
    .insert(players)
    .values({
      playerUid,
      lastName: displayName,
      rawLastPlayer: {
        source: "discord_bot",
        discord_user_id: input.discordUserId ?? null,
        guild_id: input.guildId ?? null,
        role_id: input.roleId ?? null,
        raw_member: input.rawMember ?? {},
        created_by: "bot_assignment"
      }
    })
    .onConflictDoUpdate({
      target: players.playerUid,
      set: {
        lastName: sql`COALESCE(${players.lastName}, excluded.last_name)`,
        deletedAt: null,
        updatedAt: sql`now()`
      }
    });
}

async function upsertLink(tx: DrizzleTransaction, playerUid: string, input: ResolveDiscordPlayerInput): Promise<LinkRow | null> {
  if (!input.discordUserId) {
    return null;
  }

  const rows = await tx
    .insert(playerDiscordLinks)
    .values({
      playerUid,
      discordUserId: input.discordUserId,
      discordUsername: input.discordUsername ?? null,
      discordDisplayName: input.discordDisplayName ?? input.nick ?? null,
      source: "bot",
      verifiedAt: null,
      rawLink: {
        source: "discord_bot",
        guild_id: input.guildId ?? null,
        role_id: input.roleId ?? null,
        raw_member: input.rawMember ?? {}
      }
    })
    .onConflictDoUpdate({
      target: playerDiscordLinks.discordUserId,
      set: {
        playerUid: sql`excluded.player_uid`,
        discordUsername: sql`COALESCE(excluded.discord_username, ${playerDiscordLinks.discordUsername})`,
        discordDisplayName: sql`COALESCE(excluded.discord_display_name, ${playerDiscordLinks.discordDisplayName})`,
        source: sql`CASE WHEN ${playerDiscordLinks.source} = 'manual' THEN ${playerDiscordLinks.source} ELSE excluded.source END`,
        rawLink: sql`excluded.raw_link`,
        updatedAt: sql`now()`
      }
    })
    .returning(linkReturning);

  return rows[0] ?? null;
}

async function resolveOrCreateDiscordLinkedPlayerInTransaction(
  tx: DrizzleTransaction,
  input: ResolveDiscordPlayerInput,
  dryRun: boolean
): Promise<ResolvedDiscordPlayer> {
  const createPlayerIfMissing = input.createPlayerIfMissing ?? true;
  const existingLink = input.discordUserId ? await findLink(tx, input.discordUserId) : null;
  const playerUid = input.playerUid ?? existingLink?.player_uid ?? (input.discordUserId ? placeholderUid(input.discordUserId) : null);
  const identifierUsed: IdentifierUsed = input.playerUid ? "player_uid" : "discord_user_id";

  if (!playerUid) {
    throw new DiscordPlayerAssignmentError("player_not_found", "Player was not found.", 404);
  }

  const existingPlayer = await findPlayer(tx, playerUid);

  if (!existingPlayer && !createPlayerIfMissing) {
    throw new DiscordPlayerAssignmentError(
      "player_not_found",
      "Player was not found and create_player_if_missing is false.",
      404
    );
  }

  const wouldCreatePlayer = !existingPlayer;
  const wouldCreateLink = Boolean(input.discordUserId && (!existingLink || existingLink.player_uid !== playerUid));

  if (!dryRun && !existingPlayer) {
    await upsertPlayer(tx, playerUid, displayNameFor(input, playerUid), input);
  }

  const link = dryRun ? existingLink : await upsertLink(tx, playerUid, input);
  const player = existingPlayer ?? { player_uid: playerUid, last_name: displayNameFor(input, playerUid) };

  return {
    player_uid: player.player_uid,
    last_name: player.last_name,
    identifier_used: identifierUsed,
    created_player: !dryRun && wouldCreatePlayer,
    created_link: !dryRun && wouldCreateLink,
    would_create_player: wouldCreatePlayer,
    would_create_link: wouldCreateLink,
    link
  };
}

export async function resolveOrCreateDiscordLinkedPlayer(input: ResolveDiscordPlayerInput): Promise<ResolvedDiscordPlayer> {
  return getDrizzleDb().transaction((tx) => resolveOrCreateDiscordLinkedPlayerInTransaction(tx, input, false));
}

export async function ensureDiscordLinkedPlayerForTransaction(
  tx: DrizzleTransaction,
  input: ResolveDiscordPlayerInput
): Promise<ResolvedDiscordPlayer> {
  return resolveOrCreateDiscordLinkedPlayerInTransaction(tx, input, false);
}

async function resolveUnit(tx: DrizzleTransaction, input: DiscordBotUnitAssignmentInput): Promise<UnitRow> {
  const lookupCondition =
    input.unitId && input.unitKey
      ? or(eq(units.id, input.unitId), eq(units.unitKey, input.unitKey))
      : input.unitId
        ? eq(units.id, input.unitId)
        : input.unitKey
          ? eq(units.unitKey, input.unitKey)
          : null;

  if (!lookupCondition) {
    throw new DiscordPlayerAssignmentError("unit_not_found", "Unit was not found.", 404);
  }

  const rows = await tx
    .select({
      id: sql<string>`${units.id}::text`,
      unit_key: units.unitKey
    })
    .from(units)
    .where(and(isNull(units.deletedAt), lookupCondition))
    .orderBy(input.unitId ? sql`CASE WHEN ${units.id} = ${input.unitId}::uuid THEN 0 ELSE 1 END` : asc(units.unitKey))
    .limit(1);

  const unit = rows[0];

  if (!unit) {
    throw new DiscordPlayerAssignmentError("unit_not_found", "Unit was not found.", 404);
  }

  return unit;
}

async function findLockedAssignment(tx: DrizzleTransaction, playerUid: string): Promise<LockedAssignmentRow | null> {
  const rows = await tx
    .select({
      unit_id: sql<string>`${unitPlayers.unitId}::text`,
      roster_status: unitPlayers.rosterStatus,
      assignment_source: unitPlayers.assignmentSource
    })
    .from(unitPlayers)
    .where(
      and(
        eq(unitPlayers.playerUid, playerUid),
        eq(unitPlayers.assignmentLocked, true),
        eq(unitPlayers.isActive, true),
        ne(unitPlayers.rosterStatus, "inactive")
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

async function findCurrentAssignment(tx: DrizzleTransaction, playerUid: string): Promise<AssignmentRow | null> {
  const rows = await tx
    .select(assignmentReturning)
    .from(unitPlayers)
    .where(and(eq(unitPlayers.playerUid, playerUid), eq(unitPlayers.isActive, true), ne(unitPlayers.rosterStatus, "inactive")))
    .orderBy(sql`CASE WHEN ${unitPlayers.assignmentSource} = 'discord' THEN 0 ELSE 1 END`, desc(unitPlayers.updatedAt))
    .limit(1);

  return rows[0] ?? null;
}

async function auditAssignment(
  tx: DrizzleTransaction,
  input: DiscordBotUnitAssignmentInput,
  playerUid: string,
  action: "apply" | "skip",
  previousValue: unknown,
  nextValue: unknown
): Promise<void> {
  await tx.insert(discordAssignmentAudits).values({
    userId: null,
    playerUid,
    discordUserId: input.discordUserId ?? null,
    action,
    field: "unit_primary",
    previousValue: (previousValue ?? null) as Record<string, unknown> | null,
    nextValue: (nextValue ?? null) as Record<string, unknown> | null,
    winningClaim: {
      source: "direct_bot_assignment",
      guild_id: input.guildId ?? null,
      role_id: input.roleId ?? null,
      assignment_priority: input.assignmentPriority ?? 0,
      input_identifier: input.playerUid ? "player_uid" : "discord_user_id"
    },
    ignoredClaims: [],
    source: "bot_assignment"
  });
}

async function upsertAssignment(
  tx: DrizzleTransaction,
  input: DiscordBotUnitAssignmentInput,
  unitId: string,
  playerUid: string
): Promise<AssignmentRow> {
  const rank = input.rankId ? null : input.rank ?? null;
  const rosterName = input.rosterName ?? input.nick ?? input.discordDisplayName ?? null;
  const rows = await tx
    .insert(unitPlayers)
    .values({
      unitId,
      playerUid,
      rank,
      rosterName,
      isActive: input.isActive ?? true,
      rosterStatus: input.rosterStatus ?? "active",
      joinedUnitAt: sql`now()`,
      assignmentSource: "discord",
      assignmentPriority: input.assignmentPriority ?? 0,
      rankId: input.rankId ?? null,
      sourceGuildId: input.guildId ?? null,
      sourceRoleId: input.roleId ?? null
    })
    .onConflictDoUpdate({
      target: [unitPlayers.unitId, unitPlayers.playerUid],
      set: {
        rank: sql`COALESCE(excluded.rank, ${unitPlayers.rank})`,
        rosterName: sql`COALESCE(excluded.roster_name, ${unitPlayers.rosterName})`,
        isActive: sql`excluded.is_active`,
        rosterStatus: sql`excluded.roster_status`,
        assignmentSource: "discord",
        assignmentPriority: sql`excluded.assignment_priority`,
        rankId: sql`COALESCE(excluded.rank_id, ${unitPlayers.rankId})`,
        sourceGuildId: sql`excluded.source_guild_id`,
        sourceRoleId: sql`excluded.source_role_id`,
        leftUnitAt: sql`CASE WHEN excluded.is_active THEN NULL ELSE ${unitPlayers.leftUnitAt} END`,
        updatedAt: sql`now()`
      },
      setWhere: sql`${unitPlayers.assignmentLocked} = false AND ${unitPlayers.assignmentSource} <> 'manual'`
    })
    .returning(assignmentReturning);

  const assignment = rows[0];

  if (assignment) {
    return assignment;
  }

  const existingRows = await tx
    .select(assignmentReturning)
    .from(unitPlayers)
    .where(and(eq(unitPlayers.unitId, unitId), eq(unitPlayers.playerUid, playerUid)))
    .limit(1);

  const existingAssignment = existingRows[0];

  if (!existingAssignment) {
    throw new Error("Discord assignment upsert returned no row.");
  }

  return existingAssignment;
}

export async function applyDiscordBotUnitAssignment(input: DiscordBotUnitAssignmentInput): Promise<DiscordBotUnitAssignmentResult> {
  return getDrizzleDb().transaction(async (tx) => {
    const dryRun = input.dryRun ?? false;
    const unit = await resolveUnit(tx, input);
    const player = await resolveOrCreateDiscordLinkedPlayerInTransaction(tx, input, dryRun);
    const lockedAssignment = await findLockedAssignment(tx, player.player_uid);

    if (lockedAssignment) {
      if (!dryRun) {
        await auditAssignment(tx, input, player.player_uid, "skip", lockedAssignment, { blocked: "assignment_locked", unit_id: unit.id });
      }

      return {
        ok: false,
        code: "assignment_locked",
        message: "Existing player assignment is locked and cannot be overwritten by Discord bot automation.",
        player_uid: player.player_uid,
        locked_assignment: lockedAssignment,
        audits_written: dryRun ? 0 : 1
      };
    }

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        identifier_used: player.identifier_used,
        would_create_player: player.would_create_player,
        would_create_link: player.would_create_link,
        would_assign: true,
        resolved_player_uid: player.player_uid,
        unit_id: unit.id
      };
    }

    const previousAssignment = await findCurrentAssignment(tx, player.player_uid);
    await tx
      .update(unitPlayers)
      .set({
        isActive: false,
        rosterStatus: "inactive",
        leftUnitAt: sql`COALESCE(${unitPlayers.leftUnitAt}, now())`,
        updatedAt: sql`now()`
      })
      .where(
        and(
          eq(unitPlayers.playerUid, player.player_uid),
          ne(unitPlayers.unitId, unit.id),
          inArray(unitPlayers.assignmentSource, ["discord", "auth-default"]),
          eq(unitPlayers.assignmentLocked, false),
          eq(unitPlayers.isActive, true)
        )
      );
    const assignment = await upsertAssignment(tx, input, unit.id, player.player_uid);

    await auditAssignment(tx, input, player.player_uid, "apply", previousAssignment, assignment);

    return {
      ok: true,
      dry_run: false,
      identifier_used: player.identifier_used,
      created_player: player.created_player,
      created_link: player.created_link,
      player: {
        player_uid: player.player_uid,
        last_name: player.last_name
      },
      link: player.link,
      assignment,
      audits_written: 1
    };
  });
}

export async function ensureDiscordPlaceholderPlayerForReconcile(input: ResolveDiscordPlayerInput): Promise<ResolvedDiscordPlayer> {
  return getDrizzleDb().transaction((tx) => resolveOrCreateDiscordLinkedPlayerInTransaction(tx, input, false));
}
