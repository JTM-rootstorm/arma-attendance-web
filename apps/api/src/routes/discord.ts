import type { FastifyInstance } from "fastify";

import { registerDiscordAttendanceRuleRoutes } from "./discord/attendanceRules.js";
import { registerDiscordAuditRoutes } from "./discord/audits.js";
import { registerDiscordAuthPolicyRoutes } from "./discord/authPolicy.js";
import { registerDiscordGuildRoutes } from "./discord/guilds.js";
import { registerDiscordMemberSnapshotRoutes } from "./discord/memberSnapshots.js";
import { registerDiscordPlayerAssignmentRoutes } from "./discord/playerAssignments.js";
import { registerDiscordPlayerLinkRoutes } from "./discord/playerLinks.js";
import { registerDiscordReconcileRoutes } from "./discord/reconcile.js";
import { registerDiscordRoleActionRoutes } from "./discord/roleActions.js";
import { registerDiscordRoleMappingRoutes } from "./discord/roleMappings.js";
import { registerDiscordRoleRoutes } from "./discord/roles.js";

export async function registerDiscordRoutes(app: FastifyInstance) {
  await registerDiscordAuthPolicyRoutes(app);
  await registerDiscordGuildRoutes(app);
  await registerDiscordRoleRoutes(app);
  await registerDiscordMemberSnapshotRoutes(app);
  await registerDiscordRoleMappingRoutes(app);
  await registerDiscordPlayerAssignmentRoutes(app);
  await registerDiscordPlayerLinkRoutes(app);
  await registerDiscordAttendanceRuleRoutes(app);
  await registerDiscordRoleActionRoutes(app);
  await registerDiscordReconcileRoutes(app);
  await registerDiscordAuditRoutes(app);
}
