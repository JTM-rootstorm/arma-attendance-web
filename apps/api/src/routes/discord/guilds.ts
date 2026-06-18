import type { FastifyInstance } from "fastify";
import { and, eq, notInArray, sql } from "drizzle-orm";

import { requireAdminOrBotToken } from "../../auth.js";
import { getDrizzleDb } from "../../db/drizzle.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { queryDb } from "../../db/pool.js";
import { discordGuilds, discordRoles } from "../../db/schema/discord.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import { guildParamsSchema, guildSyncSchema, requireAnyDiscordAdmin } from "./shared.js";

export async function registerDiscordGuildRoutes(app: FastifyInstance) {
  app.post("/v1/discord/guilds/sync", { preHandler: requireAdminOrBotToken }, async (request, reply) => {
    const parsed = guildSyncSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const { guild, roles } = parsed.data;

    try {
      const db = getDrizzleDb();
      const deletedCount = await db.transaction(async (tx) => {
        await tx
          .insert(discordGuilds)
          .values({
            guildId: guild.guild_id,
            name: guild.name,
            iconUrl: guild.icon_url ?? null,
            botUserId: guild.bot_user_id ?? null,
            botPresent: guild.bot_present ?? true,
            lastRoleSyncAt: sql`now()`,
            rawGuild: guild
          })
          .onConflictDoUpdate({
            target: discordGuilds.guildId,
            set: {
              name: sql`excluded.name`,
              iconUrl: sql`excluded.icon_url`,
              botUserId: sql`excluded.bot_user_id`,
              botPresent: sql`excluded.bot_present`,
              lastRoleSyncAt: sql`now()`,
              rawGuild: sql`excluded.raw_guild`,
              updatedAt: sql`now()`
            }
          });

        for (const role of roles) {
          await tx
            .insert(discordRoles)
            .values({
              guildId: guild.guild_id,
              roleId: role.role_id,
              name: role.name,
              color: role.color ?? null,
              position: role.position ?? null,
              managed: role.managed ?? false,
              assignable: role.assignable ?? true,
              isDeleted: false,
              lastSeenAt: sql`now()`,
              rawRole: role
            })
            .onConflictDoUpdate({
              target: [discordRoles.guildId, discordRoles.roleId],
              set: {
                name: sql`excluded.name`,
                color: sql`excluded.color`,
                position: sql`excluded.position`,
                managed: sql`excluded.managed`,
                assignable: sql`excluded.assignable`,
                isDeleted: false,
                lastSeenAt: sql`now()`,
                rawRole: sql`excluded.raw_role`,
                updatedAt: sql`now()`
              }
            });
        }

        const roleIds = roles.map((role) => role.role_id);
        const deletedRoles =
          roleIds.length === 0
            ? await tx
                .update(discordRoles)
                .set({ isDeleted: true, updatedAt: sql`now()` })
                .where(and(eq(discordRoles.guildId, guild.guild_id), eq(discordRoles.isDeleted, false)))
                .returning({ role_id: discordRoles.roleId })
            : await tx
                .update(discordRoles)
                .set({ isDeleted: true, updatedAt: sql`now()` })
                .where(and(eq(discordRoles.guildId, guild.guild_id), eq(discordRoles.isDeleted, false), notInArray(discordRoles.roleId, roleIds)))
                .returning({ role_id: discordRoles.roleId });

        return deletedRoles.length;
      });

      return {
        ok: true,
        guild_id: guild.guild_id,
        roles_seen: roles.length,
        roles_upserted: roles.length,
        roles_marked_deleted: deletedCount
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to sync Discord guild");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    try {
      const result = await queryDb(
        `
        SELECT
          dg.*,
          COUNT(DISTINCT dr.role_id)::int AS role_count,
          COUNT(DISTINCT pdl.discord_user_id)::int AS linked_member_count,
          COUNT(DISTINCT dar.id) FILTER (WHERE dar.is_enabled = true)::int AS enabled_rule_count
        FROM discord_guilds dg
        LEFT JOIN discord_roles dr ON dr.guild_id = dg.guild_id AND dr.is_deleted = false
        LEFT JOIN discord_member_snapshots dms ON dms.guild_id = dg.guild_id
        LEFT JOIN player_discord_links pdl ON pdl.discord_user_id = dms.discord_user_id
        LEFT JOIN discord_attendance_rules dar ON dar.guild_id = dg.guild_id
        GROUP BY dg.guild_id
        ORDER BY dg.updated_at DESC
        `
      );

      return { ok: true, guilds: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await queryDb(
        `
        SELECT
          dg.*,
          COUNT(DISTINCT dr.role_id)::int AS role_count,
          COUNT(DISTINCT pdl.discord_user_id)::int AS linked_member_count,
          COUNT(DISTINCT dar.id) FILTER (WHERE dar.is_enabled = true)::int AS enabled_rule_count
        FROM discord_guilds dg
        LEFT JOIN discord_roles dr ON dr.guild_id = dg.guild_id AND dr.is_deleted = false
        LEFT JOIN discord_member_snapshots dms ON dms.guild_id = dg.guild_id
        LEFT JOIN player_discord_links pdl ON pdl.discord_user_id = dms.discord_user_id
        LEFT JOIN discord_attendance_rules dar ON dar.guild_id = dg.guild_id
        WHERE dg.guild_id = $1
        GROUP BY dg.guild_id
        `,
        [parsedParams.data.guild_id]
      );

      const guild = result.rows[0];

      if (!guild) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      return { ok: true, guild };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });
}
