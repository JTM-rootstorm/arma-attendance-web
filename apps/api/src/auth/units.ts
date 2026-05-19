import type { FastifyReply } from "fastify";

import { hasRole, type CurrentUser } from "../auth.js";
import { queryDb } from "../db/pool.js";

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
  const result = await queryDb<UnitRow>("SELECT id FROM units WHERE unit_key = 'tcw' AND is_active = true LIMIT 1");
  return result.rows[0]?.id ?? null;
}

export async function getAllUnitIds(): Promise<string[]> {
  const result = await queryDb<UnitRow>("SELECT id FROM units WHERE is_active = true ORDER BY unit_key");
  return result.rows.map((row) => row.id);
}

export async function getUserUnitRoles(userId: string): Promise<UserUnitRole[]> {
  const result = await queryDb<UserUnitRole>(
    `
    WITH roles AS (
      SELECT unit_id, user_id, role
      FROM unit_memberships
      WHERE role IN ('member', 'officer', 'admin')

      UNION

      SELECT unit_id, user_id, role
      FROM unit_user_roles
      WHERE role IN ('officer', 'admin', 'tcw_admin')
    )
    SELECT
      roles.unit_id,
      u.unit_key,
      u.name,
      roles.role
    FROM roles
    JOIN units u ON u.id = roles.unit_id
    WHERE roles.user_id = $1
      AND u.is_active = true
    ORDER BY u.unit_key, roles.role
    `,
    [userId]
  );

  return result.rows;
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

export async function requireUnitAdmin(user: CurrentUser, unitId: string, reply: FastifyReply): Promise<boolean> {
  if (await hasUnitRole(user, unitId, "admin")) {
    return true;
  }

  forbidden(reply);
  return false;
}
