import { withDbTransaction, type DbTransaction } from "../db/transactions.js";

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

async function findPlayer(tx: DbTransaction, playerUid: string): Promise<PlayerRow | null> {
  const result = await tx.query<PlayerRow>(
    "SELECT player_uid, last_name FROM players WHERE player_uid = $1 AND deleted_at IS NULL",
    [playerUid]
  );
  return result.rows[0] ?? null;
}

async function findLink(tx: DbTransaction, discordUserId: string): Promise<LinkRow | null> {
  const result = await tx.query<LinkRow>(
    `
    SELECT player_uid, discord_user_id, discord_username, discord_display_name, source, verified_at
    FROM player_discord_links
    WHERE discord_user_id = $1
    LIMIT 1
    `,
    [discordUserId]
  );
  return result.rows[0] ?? null;
}

async function upsertPlayer(tx: DbTransaction, playerUid: string, displayName: string, input: ResolveDiscordPlayerInput): Promise<void> {
  await tx.query(
    `
    INSERT INTO players (player_uid, last_name, raw_last_player)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (player_uid) DO UPDATE
    SET
      last_name = COALESCE(players.last_name, EXCLUDED.last_name),
      deleted_at = NULL,
      updated_at = now()
    `,
    [
      playerUid,
      displayName,
      JSON.stringify({
        source: "discord_bot",
        discord_user_id: input.discordUserId ?? null,
        guild_id: input.guildId ?? null,
        role_id: input.roleId ?? null,
        raw_member: input.rawMember ?? {},
        created_by: "bot_assignment"
      })
    ]
  );
}

async function upsertLink(tx: DbTransaction, playerUid: string, input: ResolveDiscordPlayerInput): Promise<LinkRow | null> {
  if (!input.discordUserId) {
    return null;
  }

  const result = await tx.query<LinkRow>(
    `
    INSERT INTO player_discord_links (
      player_uid,
      discord_user_id,
      discord_username,
      discord_display_name,
      source,
      verified_at,
      raw_link
    )
    VALUES ($1, $2, $3, $4, 'bot', NULL, $5::jsonb)
    ON CONFLICT (discord_user_id) DO UPDATE
    SET
      player_uid = EXCLUDED.player_uid,
      discord_username = COALESCE(EXCLUDED.discord_username, player_discord_links.discord_username),
      discord_display_name = COALESCE(EXCLUDED.discord_display_name, player_discord_links.discord_display_name),
      source = CASE
        WHEN player_discord_links.source = 'manual' THEN player_discord_links.source
        ELSE EXCLUDED.source
      END,
      raw_link = EXCLUDED.raw_link,
      updated_at = now()
    RETURNING player_uid, discord_user_id, discord_username, discord_display_name, source, verified_at
    `,
    [
      playerUid,
      input.discordUserId,
      input.discordUsername ?? null,
      input.discordDisplayName ?? input.nick ?? null,
      JSON.stringify({
        source: "discord_bot",
        guild_id: input.guildId ?? null,
        role_id: input.roleId ?? null,
        raw_member: input.rawMember ?? {}
      })
    ]
  );

  return result.rows[0] ?? null;
}

async function resolveOrCreateDiscordLinkedPlayerInTransaction(
  tx: DbTransaction,
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
  return withDbTransaction((tx) => resolveOrCreateDiscordLinkedPlayerInTransaction(tx, input, false));
}

export async function resolveDiscordLinkedPlayerUid(tx: DbTransaction, discordUserId: string): Promise<string | null> {
  const link = await findLink(tx, discordUserId);
  return link?.player_uid ?? null;
}

export async function ensureDiscordLinkedPlayerForTransaction(
  tx: DbTransaction,
  input: ResolveDiscordPlayerInput
): Promise<ResolvedDiscordPlayer> {
  return resolveOrCreateDiscordLinkedPlayerInTransaction(tx, input, false);
}

async function resolveUnit(tx: DbTransaction, input: DiscordBotUnitAssignmentInput): Promise<UnitRow> {
  const result = await tx.query<UnitRow>(
    `
    SELECT id::text, unit_key
    FROM units
    WHERE deleted_at IS NULL
      AND (
        ($1::uuid IS NOT NULL AND id = $1::uuid)
        OR ($2::text IS NOT NULL AND unit_key = $2::text)
      )
    ORDER BY CASE WHEN $1::uuid IS NOT NULL AND id = $1::uuid THEN 0 ELSE 1 END
    LIMIT 1
    `,
    [input.unitId ?? null, input.unitKey ?? null]
  );
  const unit = result.rows[0];

  if (!unit) {
    throw new DiscordPlayerAssignmentError("unit_not_found", "Unit was not found.", 404);
  }

  return unit;
}

async function findLockedAssignment(tx: DbTransaction, playerUid: string): Promise<LockedAssignmentRow | null> {
  const result = await tx.query<LockedAssignmentRow>(
    `
    SELECT unit_id::text, roster_status, assignment_source
    FROM unit_players
    WHERE player_uid = $1
      AND assignment_locked = true
      AND is_active = true
      AND roster_status <> 'inactive'
    LIMIT 1
    `,
    [playerUid]
  );

  return result.rows[0] ?? null;
}

async function findCurrentAssignment(tx: DbTransaction, playerUid: string): Promise<AssignmentRow | null> {
  const result = await tx.query<AssignmentRow>(
    `
    SELECT
      unit_id::text,
      player_uid,
      rank,
      roster_name,
      is_active,
      roster_status,
      assignment_source,
      assignment_priority,
      rank_id::text,
      source_guild_id,
      source_role_id
    FROM unit_players
    WHERE player_uid = $1
      AND is_active = true
      AND roster_status <> 'inactive'
    ORDER BY CASE WHEN assignment_source = 'discord' THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
    `,
    [playerUid]
  );

  return result.rows[0] ?? null;
}

async function auditAssignment(
  tx: DbTransaction,
  input: DiscordBotUnitAssignmentInput,
  playerUid: string,
  action: "apply" | "skip",
  previousValue: unknown,
  nextValue: unknown
): Promise<void> {
  await tx.query(
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
    VALUES (NULL, $1, $2, $3, 'unit_primary', $4::jsonb, $5::jsonb, $6::jsonb, '[]'::jsonb, 'bot_assignment')
    `,
    [
      playerUid,
      input.discordUserId ?? null,
      action,
      JSON.stringify(previousValue ?? null),
      JSON.stringify(nextValue ?? null),
      JSON.stringify({
        source: "direct_bot_assignment",
        guild_id: input.guildId ?? null,
        role_id: input.roleId ?? null,
        assignment_priority: input.assignmentPriority ?? 0,
        input_identifier: input.playerUid ? "player_uid" : "discord_user_id"
      })
    ]
  );
}

async function upsertAssignment(
  tx: DbTransaction,
  input: DiscordBotUnitAssignmentInput,
  unitId: string,
  playerUid: string
): Promise<AssignmentRow> {
  const rank = input.rankId ? null : input.rank ?? null;
  const rosterName = input.rosterName ?? input.nick ?? input.discordDisplayName ?? null;
  const result = await tx.query<AssignmentRow>(
    `
    INSERT INTO unit_players (
      unit_id,
      player_uid,
      rank,
      roster_name,
      is_active,
      roster_status,
      joined_unit_at,
      assignment_source,
      assignment_priority,
      rank_id,
      source_guild_id,
      source_role_id
    )
    VALUES (
      $1::uuid,
      $2,
      $3,
      $4,
      $5,
      $6,
      now(),
      'discord',
      $7,
      $8::uuid,
      $9,
      $10
    )
    ON CONFLICT (unit_id, player_uid) DO UPDATE
    SET
      rank = COALESCE(EXCLUDED.rank, unit_players.rank),
      roster_name = COALESCE(EXCLUDED.roster_name, unit_players.roster_name),
      is_active = EXCLUDED.is_active,
      roster_status = EXCLUDED.roster_status,
      assignment_source = 'discord',
      assignment_priority = EXCLUDED.assignment_priority,
      rank_id = COALESCE(EXCLUDED.rank_id, unit_players.rank_id),
      source_guild_id = EXCLUDED.source_guild_id,
      source_role_id = EXCLUDED.source_role_id,
      left_unit_at = CASE WHEN EXCLUDED.is_active THEN NULL ELSE unit_players.left_unit_at END,
      updated_at = now()
    WHERE unit_players.assignment_locked = false
      AND unit_players.assignment_source <> 'manual'
    RETURNING
      unit_id::text,
      player_uid,
      rank,
      roster_name,
      is_active,
      roster_status,
      assignment_source,
      assignment_priority,
      rank_id::text,
      source_guild_id,
      source_role_id
    `,
    [
      unitId,
      playerUid,
      rank,
      rosterName,
      input.isActive ?? true,
      input.rosterStatus ?? "active",
      input.assignmentPriority ?? 0,
      input.rankId ?? null,
      input.guildId ?? null,
      input.roleId ?? null
    ]
  );

  const assignment = result.rows[0];

  if (assignment) {
    return assignment;
  }

  const existing = await tx.query<AssignmentRow>(
    `
    SELECT
      unit_id::text,
      player_uid,
      rank,
      roster_name,
      is_active,
      roster_status,
      assignment_source,
      assignment_priority,
      rank_id::text,
      source_guild_id,
      source_role_id
    FROM unit_players
    WHERE unit_id = $1::uuid AND player_uid = $2
    LIMIT 1
    `,
    [unitId, playerUid]
  );

  const existingAssignment = existing.rows[0];

  if (!existingAssignment) {
    throw new Error("Discord assignment upsert returned no row.");
  }

  return existingAssignment;
}

export async function applyDiscordBotUnitAssignment(input: DiscordBotUnitAssignmentInput): Promise<DiscordBotUnitAssignmentResult> {
  return withDbTransaction(async (tx) => {
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
    await tx.query(
      `
      UPDATE unit_players
      SET is_active = false,
          roster_status = 'inactive',
          left_unit_at = COALESCE(left_unit_at, now()),
          updated_at = now()
      WHERE player_uid = $1
        AND unit_id <> $2::uuid
        AND assignment_source IN ('discord', 'auth-default')
        AND assignment_locked = false
        AND is_active = true
      `,
      [player.player_uid, unit.id]
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
  return withDbTransaction((tx) => resolveOrCreateDiscordLinkedPlayerInTransaction(tx, input, false));
}
