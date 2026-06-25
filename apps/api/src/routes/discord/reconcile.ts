import type { FastifyInstance } from "fastify";

import { reconcileDiscordMembership } from "../../discord/membershipResolver.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import { reconcileBodySchema, requireAnyDiscordAdmin } from "./shared.js";

export async function registerDiscordReconcileRoutes(app: FastifyInstance) {
  app.post("/v1/discord/reconcile", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedBody = reconcileBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await reconcileDiscordMembership({
        ...(parsedBody.data.user_id ? { userId: parsedBody.data.user_id } : {}),
        ...(parsedBody.data.discord_user_id ? { discordUserId: parsedBody.data.discord_user_id } : {}),
        ...(parsedBody.data.guild_id ? { guildId: parsedBody.data.guild_id } : {}),
        dryRun: parsedBody.data.dry_run,
        source: parsedBody.data.dry_run ? "discord_reconcile_dry_run" : "discord_reconcile"
      });

      return result;
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to reconcile Discord membership");
      return sendDatabaseUnavailable(reply);
    }
  });
}
