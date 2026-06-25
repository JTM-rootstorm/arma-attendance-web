import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";

import { getDrizzleDb } from "../../db/drizzle.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { playerDiscordLinks } from "../../db/schema/discord.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import {
  linkParamsSchema,
  playerDiscordLinkReturning,
  playerExists,
  playerLinkBodySchema,
  playerLinksQuerySchema,
  requireAnyDiscordAdmin
} from "./shared.js";

export async function registerDiscordPlayerLinkRoutes(app: FastifyInstance) {
  app.get("/v1/discord/player-links", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedQuery = playerLinksQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    try {
      const search = parsedQuery.data.q?.trim();
      const result = await getDrizzleDb().execute(sql`
        SELECT pdl.*, p.last_name AS player_name
        FROM player_discord_links pdl
        JOIN players p ON p.player_uid = pdl.player_uid
        ${
          search
            ? sql`WHERE (p.player_uid ILIKE ${`%${search}%`} OR p.last_name ILIKE ${`%${search}%`} OR pdl.discord_user_id ILIKE ${`%${search}%`} OR pdl.discord_display_name ILIKE ${`%${search}%`})`
            : sql``
        }
        ORDER BY pdl.updated_at DESC
        LIMIT ${parsedQuery.data.limit} OFFSET ${parsedQuery.data.offset}
      `);

      return { ok: true, links: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/player-links", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsed = playerLinkBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const body = parsed.data;

    try {
      if (!(await playerExists(body.player_uid))) {
        return reply.code(404).send({ ok: false, error: { code: "player_not_found", message: "Player was not found." } });
      }

      const result = await getDrizzleDb()
        .insert(playerDiscordLinks)
        .values({
          playerUid: body.player_uid,
          discordUserId: body.discord_user_id,
          discordUsername: body.discord_username ?? null,
          discordDisplayName: body.discord_display_name ?? null,
          source: body.source,
          verifiedAt: body.verified ? sql`now()` : null,
          rawLink: body.raw_link ?? body
        })
        .onConflictDoUpdate({
          target: playerDiscordLinks.discordUserId,
          set: {
            playerUid: sql`excluded.player_uid`,
            discordUsername: sql`excluded.discord_username`,
            discordDisplayName: sql`excluded.discord_display_name`,
            source: sql`excluded.source`,
            verifiedAt: sql`COALESCE(excluded.verified_at, ${playerDiscordLinks.verifiedAt})`,
            rawLink: sql`excluded.raw_link`,
            updatedAt: sql`now()`
          }
        })
        .returning(playerDiscordLinkReturning);

      return { ok: true, link: result[0] };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to upsert Discord player link");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/discord/player-links/:discord_user_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = linkParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await getDrizzleDb()
        .delete(playerDiscordLinks)
        .where(eq(playerDiscordLinks.discordUserId, parsedParams.data.discord_user_id))
        .returning({ discord_user_id: playerDiscordLinks.discordUserId });
      return { ok: true, deleted: result.length };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });
}
