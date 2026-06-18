import type { FastifyInstance } from "fastify";

import { requireDiscordBotAssignmentWriter } from "../../auth/authorization.js";
import {
  applyDiscordBotUnitAssignment,
  DiscordPlayerAssignmentError,
  type DiscordBotUnitAssignmentInput
} from "../../discord/playerAssignment.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import { discordBotAssignmentBodySchema } from "./shared.js";

export async function registerDiscordPlayerAssignmentRoutes(app: FastifyInstance) {
  app.post("/v1/discord/player-assignments", async (request, reply) => {
    const auth = await requireDiscordBotAssignmentWriter(request, reply);

    if (!auth) {
      return;
    }

    const parsed = discordBotAssignmentBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const body = parsed.data;
    const input: DiscordBotUnitAssignmentInput = {
      discordUserId: body.discord_user_id,
      playerUid: body.player_uid,
      guildId: body.guild_id,
      roleId: body.role_id,
      unitId: body.unit_id,
      unitKey: body.unit_key,
      rankId: body.rank_id,
      rank: body.rank,
      rosterName: body.roster_name,
      rosterStatus: body.roster_status,
      discordUsername: body.discord_username,
      discordDisplayName: body.discord_display_name,
      nick: body.nick,
      isActive: body.is_active,
      assignmentPriority: body.assignment_priority,
      createPlayerIfMissing: body.create_player_if_missing,
      dryRun: body.dry_run,
      rawMember: body.raw_member
    };

    try {
      const result = await applyDiscordBotUnitAssignment(input);

      if (!result.ok) {
        return reply.code(409).send({
          ok: false,
          error: {
            code: result.code,
            message: result.message
          },
          player_uid: result.player_uid,
          locked_assignment: result.locked_assignment,
          audits_written: result.audits_written
        });
      }

      return result;
    } catch (error) {
      if (error instanceof DiscordPlayerAssignmentError) {
        return reply.code(error.statusCode).send({
          ok: false,
          error: {
            code: error.code,
            message: error.message
          }
        });
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to apply Discord bot player assignment");
      return sendDatabaseUnavailable(reply);
    }
  });
}
