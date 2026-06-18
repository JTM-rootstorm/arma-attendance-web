import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";

import { reconcileDiscordMembership } from "../../discord/membershipResolver.js";
import { getDrizzleDb } from "../../db/drizzle.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { queryDb } from "../../db/pool.js";
import { discordGuilds, discordMemberSnapshots } from "../../db/schema/discord.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import { guildExists, guildParamsSchema, memberSnapshotBodySchema, memberSnapshotQuerySchema, requireAnyDiscordAdmin } from "./shared.js";

export async function registerDiscordMemberSnapshotRoutes(app: FastifyInstance) {
  app.get("/v1/discord/guilds/:guild_id/member-snapshots", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedQuery = memberSnapshotQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [parsedParams.data.guild_id];
    const where = ["dms.guild_id = $1"];
    if (parsedQuery.data.discord_user_id) {
      values.push(parsedQuery.data.discord_user_id);
      where.push(`dms.discord_user_id = $${values.length}`);
    }
    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb(
        `
        SELECT dms.*, au.display_name AS user_display_name
        FROM discord_member_snapshots dms
        LEFT JOIN app_users au ON au.id = dms.user_id
        WHERE ${where.join(" AND ")}
        ORDER BY dms.last_seen_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return { ok: true, snapshots: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/member-snapshots", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = memberSnapshotBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;

    try {
      if (!(await guildExists(guildId))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      const members = parsedBody.data.members;
      const db = getDrizzleDb();

      await db.transaction(async (tx) => {
        for (const member of members) {
          await tx
            .insert(discordMemberSnapshots)
            .values({
              guildId,
              discordUserId: member.discord_user_id,
              roleIds: member.roles,
              nick: member.nick ?? null,
              joinedAt: member.joined_at ? new Date(member.joined_at) : null,
              memberPayload: member.raw_member ?? member,
              source: "bot_snapshot",
              lastSeenAt: sql`now()`
            })
            .onConflictDoUpdate({
              target: [discordMemberSnapshots.guildId, discordMemberSnapshots.discordUserId],
              set: {
                userId: sql`COALESCE(excluded.user_id, ${discordMemberSnapshots.userId}, (SELECT user_id FROM user_identities WHERE provider = 'discord' AND provider_user_id = excluded.discord_user_id ORDER BY last_seen_at DESC LIMIT 1))`,
                roleIds: sql`excluded.role_ids`,
                nick: sql`excluded.nick`,
                joinedAt: sql`excluded.joined_at`,
                memberPayload: sql`excluded.member_payload`,
                source: sql`excluded.source`,
                lastSeenAt: sql`now()`,
                lastError: null,
                updatedAt: sql`now()`
              }
            });
        }

        await tx
          .update(discordGuilds)
          .set({ lastMemberSyncAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(discordGuilds.guildId, guildId));
      });

      const reconciled = [];
      if (parsedBody.data.reconcile) {
        for (const discordUserId of new Set(members.map((member) => member.discord_user_id))) {
          reconciled.push(
            await reconcileDiscordMembership({
              discordUserId,
              dryRun: false,
              source: "bot_snapshot"
            })
          );
        }
      }

      return { ok: true, guild_id: guildId, snapshots_upserted: parsedBody.data.members.length, reconciled };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to ingest Discord member snapshots");
      return sendDatabaseUnavailable(reply);
    }
  });
}
