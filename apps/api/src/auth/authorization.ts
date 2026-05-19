import type { FastifyReply, FastifyRequest } from "fastify";

import { getCurrentUser, hasRole, isAdminOrBotTokenRequest, isMachineTokenRequest, type CurrentUser } from "../auth.js";
import { getVisibleUnitIds, hasUnitRole } from "./units.js";

export type AuthContext =
  | {
      kind: "machine";
      user: null;
    }
  | {
      kind: "user";
      user: CurrentUser;
    };

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    ok: false,
    error: {
      code: "unauthorized",
      message: "Missing or invalid authentication."
    }
  });
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({
    ok: false,
    error: {
      code: "forbidden",
      message: "The authenticated user does not have permission for this action."
    }
  });
}

export async function getAuthContext(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { allowMachineToken?: boolean; allowBotToken?: boolean } = {}
): Promise<AuthContext | null> {
  if (options.allowBotToken ? isAdminOrBotTokenRequest(request) : options.allowMachineToken && isMachineTokenRequest(request)) {
    return { kind: "machine", user: null };
  }

  const user = await getCurrentUser(request);

  if (!user) {
    unauthorized(reply);
    return null;
  }

  return { kind: "user", user };
}

export function canSeeSensitiveIds(user: CurrentUser | null): boolean {
  return user === null || hasRole(user, ["tcw_admin"]);
}

export async function canExportData(user: CurrentUser | null, unitId?: string | null): Promise<boolean> {
  if (user === null || hasRole(user, ["tcw_admin"])) {
    return true;
  }

  if (!unitId) {
    return false;
  }

  return hasUnitRole(user, unitId, "admin");
}

export async function canManageUnit(user: CurrentUser | null, unitId: string): Promise<boolean> {
  if (user === null || hasRole(user, ["owner"])) {
    return true;
  }

  return hasUnitRole(user, unitId, "admin");
}

export async function canReadUnitRoster(user: CurrentUser | null, unitId: string): Promise<boolean> {
  if (user === null || hasRole(user, ["owner"])) {
    return true;
  }

  return hasUnitRole(user, unitId, "officer");
}

export async function canManageDiscordMappings(user: CurrentUser | null, unitId: string): Promise<boolean> {
  return canManageUnit(user, unitId);
}

export async function canManageAttendanceRules(user: CurrentUser | null, unitId: string): Promise<boolean> {
  return canManageUnit(user, unitId);
}

export function canManageOwners(user: CurrentUser | null): boolean {
  return user !== null && hasRole(user, ["owner"]);
}

export function canSeeApiSecrets(user: CurrentUser | null): boolean {
  return user !== null && hasRole(user, ["owner"]);
}

export function canModifyApiSecrets(user: CurrentUser | null): boolean {
  return canSeeApiSecrets(user);
}

export async function getReadableUnitFilter(user: CurrentUser | null): Promise<{ all: boolean; unitIds: string[] }> {
  if (user === null || hasRole(user, ["owner"])) {
    return { all: true, unitIds: [] };
  }

  return { all: false, unitIds: await getVisibleUnitIds(user) };
}

export function deny(reply: FastifyReply) {
  return forbidden(reply);
}
