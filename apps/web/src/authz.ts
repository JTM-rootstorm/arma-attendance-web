import type { AuthUser } from "./types";

export type AppRole = AuthUser["roles"][number];

export function hasGlobalRole(user: AuthUser | null, role: AppRole): boolean {
  return Boolean(user?.roles.includes(role));
}

export function isOwner(user: AuthUser | null): boolean {
  return hasGlobalRole(user, "owner");
}

export function isTcwAdmin(user: AuthUser | null): boolean {
  return hasGlobalRole(user, "tcw_admin") || isOwner(user);
}

function hasUnitRole(user: AuthUser | null, role: "member" | "officer" | "admin"): boolean {
  const ranks = { member: 0, officer: 1, admin: 2 };
  return Boolean(user?.unit_memberships.some((membership) => ranks[membership.role] >= ranks[role]));
}

export function canOpenDashboard(user: AuthUser | null): boolean {
  return canOpenOperations(user);
}

export function canOpenOperations(user: AuthUser | null): boolean {
  return isTcwAdmin(user) || hasGlobalRole(user, "admin") || hasGlobalRole(user, "officer") || hasUnitRole(user, "officer");
}

export function canOpenRoster(user: AuthUser | null): boolean {
  return canOpenOperations(user);
}

export function canOpenComms(user: AuthUser | null): boolean {
  return isTcwAdmin(user) || hasGlobalRole(user, "admin") || hasUnitRole(user, "admin");
}

export function canOpenIdentityAdmin(user: AuthUser | null): boolean {
  return isOwner(user);
}

export function canSeeSensitiveIds(user: AuthUser | null): boolean {
  return isTcwAdmin(user);
}

export function canExport(user: AuthUser | null): boolean {
  return isTcwAdmin(user) || hasGlobalRole(user, "admin") || hasUnitRole(user, "admin");
}
