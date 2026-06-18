import { and, eq, isNull, not, sql } from "drizzle-orm";
import type { z } from "zod";

import { discordRoleMappings } from "../db/schema/discord.js";
import type { DrizzleTransaction } from "../routes/discord/shared.js";
import { discordRoleMappingReturning, roleMappingBodySchema, roleMappingPatchSchema } from "../routes/discord/shared.js";

export type RoleMappingInput = z.infer<typeof roleMappingBodySchema>;
export type RoleMappingPatch = z.infer<typeof roleMappingPatchSchema>;

export type RoleMappingDbValues = {
  guildId: string;
  roleId: string;
  mappingType: RoleMappingInput["mapping_type"];
  unitId: string | null;
  rankId: string | null;
  unitRole: string | null;
  appRole: string | null;
  rosterStatus: string | null;
  priority: number;
  isEnabled: boolean;
  notes: string | null;
};

export type RoleMappingRow = {
  id: string;
  role_id: string;
  mapping_type: RoleMappingInput["mapping_type"];
  unit_id: string | null;
  rank_id: string | null;
  unit_role: string | null;
  app_role: string | null;
  roster_status: string | null;
  priority: number;
  is_enabled: boolean;
  notes: string | null;
};

type UnitRoleMappingRole = "member" | "officer" | "admin" | "tcw_admin";
type AppRoleMappingRole = "viewer" | "officer" | "admin" | "tcw_admin" | "owner";
type RosterStatusMappingStatus = "active" | "reserve" | "loa" | "inactive";

export function roleMappingInputToDbValues(guildId: string, input: RoleMappingInput): RoleMappingDbValues {
  return {
    guildId,
    roleId: input.role_id,
    mappingType: input.mapping_type,
    unitId: "unit_id" in input ? input.unit_id ?? null : null,
    rankId: "rank_id" in input ? input.rank_id ?? null : null,
    unitRole: "unit_role" in input ? input.unit_role ?? null : null,
    appRole: "app_role" in input ? input.app_role ?? null : null,
    rosterStatus: "roster_status" in input ? input.roster_status ?? null : null,
    priority: input.priority,
    isEnabled: input.is_enabled,
    notes: input.notes ?? null
  };
}

export function roleMappingRowToInput(row: RoleMappingRow): RoleMappingInput {
  const base = {
    role_id: row.role_id,
    priority: row.priority,
    is_enabled: row.is_enabled,
    notes: row.notes
  };

  switch (row.mapping_type) {
    case "unit_primary":
    case "unit_secondary":
      return { ...base, mapping_type: row.mapping_type, unit_id: row.unit_id ?? "" };
    case "rank":
      return {
        ...base,
        mapping_type: "rank",
        rank_id: row.rank_id ?? "",
        ...(row.unit_id ? { unit_id: row.unit_id } : {})
      };
    case "unit_role":
      return { ...base, mapping_type: "unit_role", unit_id: row.unit_id ?? "", unit_role: row.unit_role as UnitRoleMappingRole };
    case "app_role":
      return { ...base, mapping_type: "app_role", app_role: row.app_role as AppRoleMappingRole };
    case "roster_status":
      return {
        ...base,
        mapping_type: "roster_status",
        roster_status: row.roster_status as RosterStatusMappingStatus,
        ...(row.unit_id ? { unit_id: row.unit_id } : {})
      };
    case "deny_login":
      return { ...base, mapping_type: "deny_login" };
  }
}

export function mergeRoleMappingPatch(current: RoleMappingInput, patch: RoleMappingPatch) {
  const merged = { ...current, ...patch };
  const base = {
    role_id: merged.role_id,
    mapping_type: merged.mapping_type,
    priority: merged.priority,
    is_enabled: merged.is_enabled,
    notes: merged.notes
  };

  switch (merged.mapping_type) {
    case "unit_primary":
    case "unit_secondary":
      return { ...base, unit_id: merged.unit_id };
    case "rank":
      return {
        ...base,
        rank_id: merged.rank_id,
        ...(merged.unit_id ? { unit_id: merged.unit_id } : {})
      };
    case "unit_role":
      return { ...base, unit_id: merged.unit_id, unit_role: merged.unit_role };
    case "app_role":
      return { ...base, app_role: merged.app_role };
    case "roster_status":
      return {
        ...base,
        roster_status: merged.roster_status,
        ...(merged.unit_id ? { unit_id: merged.unit_id } : {})
      };
    case "deny_login":
      return base;
  }
}

function sameNullableColumn(column: Parameters<typeof isNull>[0], value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

export async function findExistingRoleMapping(tx: DrizzleTransaction, values: RoleMappingDbValues, exceptId?: string) {
  const rows = await tx
    .select({ id: discordRoleMappings.id })
    .from(discordRoleMappings)
    .where(
      and(
        eq(discordRoleMappings.guildId, values.guildId),
        eq(discordRoleMappings.roleId, values.roleId),
        eq(discordRoleMappings.mappingType, values.mappingType),
        sameNullableColumn(discordRoleMappings.unitId, values.unitId),
        sameNullableColumn(discordRoleMappings.rankId, values.rankId),
        sameNullableColumn(discordRoleMappings.unitRole, values.unitRole),
        sameNullableColumn(discordRoleMappings.appRole, values.appRole),
        sameNullableColumn(discordRoleMappings.rosterStatus, values.rosterStatus),
        exceptId ? not(eq(discordRoleMappings.id, exceptId)) : undefined
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function upsertDiscordRoleMapping(tx: DrizzleTransaction, guildId: string, input: RoleMappingInput) {
  const values = roleMappingInputToDbValues(guildId, input);
  const existing = await findExistingRoleMapping(tx, values);

  if (existing) {
    const [mapping] = await tx
      .update(discordRoleMappings)
      .set({
        priority: values.priority,
        isEnabled: values.isEnabled,
        notes: values.notes,
        updatedAt: sql`now()`
      })
      .where(eq(discordRoleMappings.id, existing.id))
      .returning(discordRoleMappingReturning);

    return mapping;
  }

  const [mapping] = await tx
    .insert(discordRoleMappings)
    .values(values)
    .returning(discordRoleMappingReturning);

  return mapping;
}
