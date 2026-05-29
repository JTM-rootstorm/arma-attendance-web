import type { FastifyReply } from "fastify";
import { and, eq, inArray } from "drizzle-orm";

import { hasRole, type CurrentUser } from "../auth.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { unitMemberships, units, unitUserRoles } from "../db/schema/units.js";

export const unitRoles = ["member", "officer", "admin", "tcw_admin"] as const;
export type UnitRole = (typeof unitRoles)[number];

export type UserUnitRole = {
  unit_id: string;
  unit_key: string;
  name: string;
  role: UnitRole;
};

type UnitRow = {
  id: string;
};

const unitRoleRank: Record<UnitRole, number> = {
  member: 0,
  officer: 1,
  admin: 2,
  tcw_admin: 2
};

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({
    ok: false,
    error: {
      code: "forbidden",
      message: "The authenticated user does not have permission for this action."
    }
  });
}

export async function getDefaultUnitId(): Promise<string | null> {
  const db = getDrizzleDb();
  const rows = await db
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.unitKey, "tcw"), eq(units.isActive, true)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function getAllUnitIds(): Promise<string[]> {
  const db = getDrizzleDb();
  const rows = await db.select({ id: units.id }).from(units).where(eq(units.isActive, true)).orderBy(units.unitKey);
  return rows.map((row: UnitRow) => row.id);
}

export async function getUserUnitRoles(userId: string): Promise<UserUnitRole[]> {
  const db = getDrizzleDb();
  const membershipRows = await db
    .select({
      unit_id: unitMemberships.unitId,
      unit_key: units.unitKey,
      name: units.name,
      role: unitMemberships.role
    })
    .from(unitMemberships)
    .innerJoin(units, eq(units.id, unitMemberships.unitId))
    .where(and(eq(unitMemberships.userId, userId), inArray(unitMemberships.role, ["member", "officer", "admin"]), eq(units.isActive, true)));

  const roleRows = await db
    .select({
      unit_id: unitUserRoles.unitId,
      unit_key: units.unitKey,
      name: units.name,
      role: unitUserRoles.role
    })
    .from(unitUserRoles)
    .innerJoin(units, eq(units.id, unitUserRoles.unitId))
    .where(and(eq(unitUserRoles.userId, userId), inArray(unitUserRoles.role, ["officer", "admin", "tcw_admin"]), eq(units.isActive, true)));

  const byUnitAndRole = new Map<string, UserUnitRole>();

  for (const row of [...membershipRows, ...roleRows]) {
    if (!unitRoles.includes(row.role as UnitRole)) {
      continue;
    }

    byUnitAndRole.set(`${row.unit_id}:${row.role}`, {
      unit_id: row.unit_id,
      unit_key: row.unit_key,
      name: row.name,
      role: row.role as UnitRole
    });
  }

  return Array.from(byUnitAndRole.values()).sort((left, right) => {
    const unitKeyOrder = left.unit_key.localeCompare(right.unit_key);
    return unitKeyOrder === 0 ? left.role.localeCompare(right.role) : unitKeyOrder;
  });
}

export async function getVisibleUnitIds(user: CurrentUser): Promise<string[]> {
  if (hasRole(user, ["owner"])) {
    return getAllUnitIds();
  }

  const roles = await getUserUnitRoles(user.id);
  const visible = roles.map((role) => role.unit_id);

  if (visible.length > 0) {
    return Array.from(new Set(visible));
  }

  const defaultUnitId = await getDefaultUnitId();

  if (!defaultUnitId) {
    return [];
  }

  if (hasRole(user, ["admin", "officer", "tcw_admin"])) {
    return [defaultUnitId];
  }

  return [];
}

export async function hasUnitRole(user: CurrentUser, unitId: string, requiredRole: UnitRole): Promise<boolean> {
  if (hasRole(user, ["owner"])) {
    return true;
  }

  if (hasRole(user, ["tcw_admin"])) {
    const roles = await getUserUnitRoles(user.id);
    return roles.length === 0 || roles.some((role) => role.unit_id === unitId);
  }

  if (hasRole(user, ["admin"]) && requiredRole !== "member") {
    const defaultUnitId = await getDefaultUnitId();
    return defaultUnitId === unitId;
  }

  if (hasRole(user, ["officer"]) && requiredRole !== "admin") {
    const defaultUnitId = await getDefaultUnitId();
    return defaultUnitId === unitId;
  }

  const roles = await getUserUnitRoles(user.id);
  const requiredRank = unitRoleRank[requiredRole];

  return roles.some((role) => role.unit_id === unitId && unitRoleRank[role.role] >= requiredRank);
}

export async function requireUnitRead(user: CurrentUser, unitId: string, reply: FastifyReply): Promise<boolean> {
  if (await hasUnitRole(user, unitId, "officer")) {
    return true;
  }

  forbidden(reply);
  return false;
}

export async function requireUnitMember(user: CurrentUser, unitId: string, reply: FastifyReply): Promise<boolean> {
  if (await hasUnitRole(user, unitId, "member")) {
    return true;
  }

  forbidden(reply);
  return false;
}

export async function requireUnitAdmin(user: CurrentUser, unitId: string, reply: FastifyReply): Promise<boolean> {
  if (await hasUnitRole(user, unitId, "admin")) {
    return true;
  }

  forbidden(reply);
  return false;
}
