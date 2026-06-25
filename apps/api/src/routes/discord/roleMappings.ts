import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";

import {
  findExistingRoleMapping,
  mergeRoleMappingPatch,
  roleMappingInputToDbValues,
  roleMappingRowToInput,
  upsertDiscordRoleMapping,
  type RoleMappingRow
} from "../../discord/roleMappingModel.js";
import { getDrizzleDb } from "../../db/drizzle.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { queryDb } from "../../db/pool.js";
import { discordRoleMappings } from "../../db/schema/discord.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import {
  discordRoleMappingReturning,
  requireAnyDiscordAdmin,
  roleExists,
  roleMappingBodySchema,
  roleMappingParamsSchema,
  roleMappingPatchSchema
} from "./shared.js";
import { guildParamsSchema } from "./shared.js";

export async function registerDiscordRoleMappingRoutes(app: FastifyInstance) {
  app.get("/v1/discord/guilds/:guild_id/role-mappings", async (request, reply) => {
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
        SELECT drm.*, dr.name AS role_name, u.name AS unit_name, ur.name AS rank_name
        FROM discord_role_mappings drm
        LEFT JOIN discord_roles dr ON dr.guild_id = drm.guild_id AND dr.role_id = drm.role_id
        LEFT JOIN units u ON u.id = drm.unit_id
        LEFT JOIN unit_ranks ur ON ur.id = drm.rank_id
        WHERE drm.guild_id = $1
        ORDER BY drm.is_enabled DESC, drm.mapping_type ASC, drm.priority DESC, dr.position DESC NULLS LAST
        `,
        [parsedParams.data.guild_id]
      );

      return { ok: true, mappings: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/role-mappings", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = roleMappingBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;
    const body = parsedBody.data;

    try {
      if (!(await roleExists(guildId, body.role_id))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const mapping = await getDrizzleDb().transaction((tx) => upsertDiscordRoleMapping(tx, guildId, body));

      return { ok: true, mapping };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create Discord role mapping");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/discord/guilds/:guild_id/role-mappings/:mapping_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = roleMappingParamsSchema.safeParse(request.params);
    const parsedBody = roleMappingPatchSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    try {
      const currentResult = await getDrizzleDb()
        .select({
          id: discordRoleMappings.id,
          role_id: discordRoleMappings.roleId,
          mapping_type: discordRoleMappings.mappingType,
          unit_id: discordRoleMappings.unitId,
          rank_id: discordRoleMappings.rankId,
          unit_role: discordRoleMappings.unitRole,
          app_role: discordRoleMappings.appRole,
          roster_status: discordRoleMappings.rosterStatus,
          priority: discordRoleMappings.priority,
          is_enabled: discordRoleMappings.isEnabled,
          notes: discordRoleMappings.notes
        })
        .from(discordRoleMappings)
        .where(and(eq(discordRoleMappings.guildId, parsedParams.data.guild_id), eq(discordRoleMappings.id, parsedParams.data.mapping_id)))
        .limit(1);

      const current = currentResult[0] as RoleMappingRow | undefined;
      if (!current) {
        return reply.code(404).send({ ok: false, error: { code: "mapping_not_found", message: "Discord role mapping was not found." } });
      }

      const body = parsedBody.data;
      const merged = roleMappingBodySchema.safeParse(mergeRoleMappingPatch(roleMappingRowToInput(current), body));

      if (!merged.success) {
        return sendValidationFailed(reply);
      }

      if (merged.data.role_id !== current.role_id && !(await roleExists(parsedParams.data.guild_id, merged.data.role_id))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const values = roleMappingInputToDbValues(parsedParams.data.guild_id, merged.data);
      const duplicate = await getDrizzleDb().transaction((tx) => findExistingRoleMapping(tx, values, current.id));

      if (duplicate) {
        return reply.code(409).send({
          ok: false,
          error: {
            code: "duplicate_mapping",
            message: "A Discord role mapping with the same role, type, and target already exists."
          }
        });
      }

      const [mapping] = await getDrizzleDb()
        .update(discordRoleMappings)
        .set({
          roleId: values.roleId,
          mappingType: values.mappingType,
          unitId: values.unitId,
          rankId: values.rankId,
          unitRole: values.unitRole,
          appRole: values.appRole,
          rosterStatus: values.rosterStatus,
          priority: values.priority,
          isEnabled: values.isEnabled,
          notes: values.notes,
          updatedAt: sql`now()`
        })
        .where(and(eq(discordRoleMappings.guildId, parsedParams.data.guild_id), eq(discordRoleMappings.id, current.id)))
        .returning(discordRoleMappingReturning);

      return { ok: true, mapping };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update Discord role mapping");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/discord/guilds/:guild_id/role-mappings/:mapping_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = roleMappingParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await getDrizzleDb()
        .delete(discordRoleMappings)
        .where(and(eq(discordRoleMappings.guildId, parsedParams.data.guild_id), eq(discordRoleMappings.id, parsedParams.data.mapping_id)))
        .returning({ id: discordRoleMappings.id });

      return { ok: true, deleted: result.length };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });
}
