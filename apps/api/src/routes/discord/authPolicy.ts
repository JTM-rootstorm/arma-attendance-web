import type { FastifyInstance } from "fastify";

import { getDiscordAuthPolicy } from "../../config/discordAuth.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { queryDb } from "../../db/pool.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import { guildAuthPolicyBodySchema, guildParamsSchema, requireAnyDiscordAdmin } from "./shared.js";

export async function registerDiscordAuthPolicyRoutes(app: FastifyInstance) {
  app.get("/v1/discord/auth-policy", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    try {
      const policy = getDiscordAuthPolicy();
      const result = await queryDb(
        `
        SELECT *
        FROM discord_guilds
        ORDER BY grants_login DESC, unit_priority DESC, rank_priority DESC, config_order ASC, name ASC
        `
      );

      return { ok: true, policy, guilds: result.rows };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to load Discord auth policy");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/auth-policy/sync", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    try {
      const { syncDiscordAuthPolicyToDb } = await import("../../discord/membershipResolver.js");
      const seeded = await syncDiscordAuthPolicyToDb();
      return { ok: true, seeded_guild_count: seeded };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to seed Discord auth policy");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.put("/v1/discord/guilds/:guild_id/auth-policy", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = guildAuthPolicyBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const body = parsedBody.data;

    try {
      const result = await queryDb(
        `
        UPDATE discord_guilds
        SET guild_type = $2,
            grants_login = $3,
            sync_members = $4,
            is_fallback = $5,
            unit_priority = $6,
            rank_priority = $7,
            permission_priority = $8,
            config_order = $9,
            config_source = 'db',
            last_config_loaded_at = now(),
            updated_at = now()
        WHERE guild_id = $1
        RETURNING *
        `,
        [
          parsedParams.data.guild_id,
          body.guild_type,
          body.grants_login,
          body.sync_members,
          body.is_fallback,
          body.unit_priority,
          body.rank_priority,
          body.permission_priority,
          body.config_order
        ]
      );

      const guild = result.rows[0];
      if (!guild) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      return { ok: true, guild };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update Discord auth policy");
      return sendDatabaseUnavailable(reply);
    }
  });
}
