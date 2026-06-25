import type { FastifyReply, FastifyRequest } from "fastify";

import { getCurrentUser, hasRole, type CurrentUser, type MachineTokenKind } from "../auth.js";
import { sendForbidden, sendUnauthorized } from "../http/responses.js";
import { type AuthContextOptions, resolveMachineTokenKind } from "./authContext.js";
import { machineTokenKindSets } from "./machineTokenKinds.js";
import { getVisibleUnitIds, hasUnitRole } from "./units.js";

export type AuthContext =
  | {
      kind: "machine";
      user: null;
      machineTokenKind: MachineTokenKind;
    }
  | {
      kind: "user";
      user: CurrentUser;
      machineTokenKind: null;
    };

export type AnonymousAuthContext = {
  kind: "anonymous";
  user: null;
  machineTokenKind: null;
};

export async function getAuthContext(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuthContextOptions = {}
): Promise<AuthContext | null> {
  const tokenKind = await resolveMachineTokenKind(request, options);

  if (tokenKind) {
    return { kind: "machine", user: null, machineTokenKind: tokenKind };
  }

  const user = await getCurrentUser(request);

  if (!user) {
    sendUnauthorized(reply);
    return null;
  }

  return { kind: "user", user, machineTokenKind: null };
}

export async function getOptionalAuthContext(
  request: FastifyRequest,
  options: {
    allowMachineToken?: boolean;
    allowBotToken?: boolean;
    machineTokenKinds?: readonly MachineTokenKind[];
    ignoreInvalidCredentials?: boolean;
  } = {}
): Promise<AuthContext | AnonymousAuthContext> {
  try {
    const tokenKind = await resolveMachineTokenKind(request, options);

    if (tokenKind) {
      return { kind: "machine", user: null, machineTokenKind: tokenKind };
    }

    const user = await getCurrentUser(request);

    if (user) {
      return { kind: "user", user, machineTokenKind: null };
    }
  } catch (error) {
    if (!options.ignoreInvalidCredentials) {
      throw error;
    }

    request.log.debug({ authError: error }, "Ignoring invalid optional credentials.");
  }

  return { kind: "anonymous", user: null, machineTokenKind: null };
}

export async function requireDiscordBotAssignmentWriter(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthContext | null> {
  return getAuthContext(request, reply, { machineTokenKinds: machineTokenKindSets.botWriter });
}

export function canSeeSensitiveIds(user: CurrentUser | null, machineTokenKind?: MachineTokenKind | null): boolean {
  return user === null ? Boolean(machineTokenKind && machineTokenKind !== "base44_integration") : hasRole(user, ["tcw_admin"]);
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
  return sendForbidden(reply);
}
