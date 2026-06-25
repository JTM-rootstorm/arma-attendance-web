import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";

import { upsertDiscordRoleMapping } from "../../discord/roleMappingModel.js";
import { getDrizzleDb } from "../../db/drizzle.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { discordGuilds, discordRoleMappings, discordRoles } from "../../db/schema/discord.js";
import { unitDiscordGuilds, units } from "../../db/schema/units.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import { guildExists, guildParamsSchema, requireAnyDiscordAdmin, roleBodySchema, roleParamsSchema } from "./shared.js";

export async function registerDiscordRoleRoutes(app: FastifyInstance) {
  app.get("/v1/discord/guilds/:guild_id/roles", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await getDrizzleDb().execute(sql`
        SELECT *
        FROM discord_roles
        WHERE guild_id = ${parsedParams.data.guild_id}
        ORDER BY position DESC NULLS LAST, name ASC
      `);

      return { ok: true, roles: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/roles", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = roleBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;
    const body = parsedBody.data;

    try {
      if (!(await guildExists(guildId))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      return await getDrizzleDb().transaction(async (tx) => {
        const [role] = await tx
          .insert(discordRoles)
          .values({
            guildId,
            roleId: body.role_id,
            name: body.name,
            assignable: body.assignable,
            managed: false,
            isDeleted: false,
            rawRole: { source: "manual_admin" }
          })
          .onConflictDoUpdate({
            target: [discordRoles.guildId, discordRoles.roleId],
            set: {
              name: sql`excluded.name`,
              assignable: sql`excluded.assignable`,
              managed: false,
              isDeleted: false,
              lastSeenAt: sql`now()`,
              updatedAt: sql`now()`,
              rawRole: sql`excluded.raw_role`
            }
          })
          .returning({
            guild_id: discordRoles.guildId,
            role_id: discordRoles.roleId,
            name: discordRoles.name,
            color: discordRoles.color,
            position: discordRoles.position,
            managed: discordRoles.managed,
            assignable: discordRoles.assignable,
            is_deleted: discordRoles.isDeleted,
            last_seen_at: discordRoles.lastSeenAt,
            updated_at: discordRoles.updatedAt
          });

        await tx
          .update(discordGuilds)
          .set({
            grantsLogin: true,
            syncMembers: true,
            configSource: sql`CASE WHEN ${discordGuilds.configSource} = 'file' THEN ${discordGuilds.configSource} ELSE 'db' END`,
            lastConfigLoadedAt: sql`now()`,
            updatedAt: sql`now()`
          })
          .where(eq(discordGuilds.guildId, guildId));

        const linkedUnits = body.unit_id
          ? await tx
              .select({
                unit_id: units.id
              })
              .from(units)
              .where(and(eq(units.id, body.unit_id), sql`${units.deletedAt} IS NULL`))
              .limit(1)
          : await tx
              .selectDistinct({
                unit_id: units.id
              })
              .from(units)
              .leftJoin(unitDiscordGuilds, eq(unitDiscordGuilds.unitId, units.id))
              .where(and(sql`${units.deletedAt} IS NULL`, sql`(${units.primaryDiscordGuildId} = ${guildId} OR ${unitDiscordGuilds.guildId} = ${guildId})`))
              .limit(2);

        if (body.unit_id && linkedUnits.length === 0) {
          return reply.code(404).send({ ok: false, error: { code: "unit_not_found", message: "Battalion was not found." } });
        }

        if (!body.unit_id && linkedUnits.length !== 1) {
          return { ok: true, role, mapping: null, linked_unit_count: linkedUnits.length };
        }

        const unitId = linkedUnits[0]?.unit_id;
        if (!unitId) {
          return { ok: true, role, mapping: null, linked_unit_count: linkedUnits.length };
        }

        const mapping = await upsertDiscordRoleMapping(tx, guildId, {
          role_id: body.role_id,
          mapping_type: "unit_primary",
          unit_id: unitId,
          priority: body.priority,
          is_enabled: true,
          notes: "Created from COMMS unit mapping role attach."
        });

        const memberMapping = await upsertDiscordRoleMapping(tx, guildId, {
          role_id: body.role_id,
          mapping_type: "unit_role",
          unit_id: unitId,
          unit_role: "member",
          priority: body.priority,
          is_enabled: true,
          notes: "Created from COMMS unit mapping role attach."
        });

        return { ok: true, role, mapping, member_mapping: memberMapping, linked_unit_count: linkedUnits.length };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to attach Discord role");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/discord/guilds/:guild_id/roles/:role_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = roleParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { guild_id: guildId, role_id: roleId } = parsedParams.data;

    try {
      return await getDrizzleDb().transaction(async (tx) => {
        const [role] = await tx
          .select({ role_id: discordRoles.roleId })
          .from(discordRoles)
          .where(and(eq(discordRoles.guildId, guildId), eq(discordRoles.roleId, roleId)))
          .limit(1);

        if (!role) {
          return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
        }

        const removedMappings = await tx
          .delete(discordRoleMappings)
          .where(and(eq(discordRoleMappings.guildId, guildId), eq(discordRoleMappings.roleId, roleId)))
          .returning({ id: discordRoleMappings.id });

        await tx
          .update(discordRoles)
          .set({
            assignable: false,
            isDeleted: true,
            updatedAt: sql`now()`
          })
          .where(and(eq(discordRoles.guildId, guildId), eq(discordRoles.roleId, roleId)));

        return { ok: true, role_id: roleId, removed_mapping_count: removedMappings.length };
      });
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to delete Discord role");
      return sendDatabaseUnavailable(reply);
    }
  });
}
