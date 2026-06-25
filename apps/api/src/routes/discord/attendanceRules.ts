import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";

import { getDrizzleDb } from "../../db/drizzle.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { discordAttendanceRules } from "../../db/schema/discord.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import {
  discordAttendanceRuleReturning,
  guildExists,
  guildParamsSchema,
  requireAnyDiscordAdmin,
  roleExists,
  ruleBodySchema,
  ruleParamsSchema,
  rulePatchSchema
} from "./shared.js";

export async function registerDiscordAttendanceRuleRoutes(app: FastifyInstance) {
  app.get("/v1/discord/guilds/:guild_id/rules", async (request, reply) => {
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
        SELECT dar.*, dr.name AS role_name
        FROM discord_attendance_rules dar
        JOIN discord_roles dr ON dr.guild_id = dar.guild_id AND dr.role_id = dar.role_id
        WHERE dar.guild_id = ${parsedParams.data.guild_id}
        ORDER BY dar.created_at DESC
      `);
      return { ok: true, rules: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/rules", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = ruleBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;
    const body = parsedBody.data;

    try {
      if (!(await guildExists(guildId))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      if (!(await roleExists(guildId, body.role_id))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const result = await getDrizzleDb()
        .insert(discordAttendanceRules)
        .values({
          guildId,
          roleId: body.role_id,
          name: body.name,
          description: body.description ?? null,
          isEnabled: body.is_enabled,
          minAttendancePoints: body.min_attendance_points,
          minOperationCount: body.min_operation_count,
          minAttendancePercent: body.min_attendance_percent === undefined ? null : String(body.min_attendance_percent),
          lookbackDays: body.lookback_days ?? null,
          serverKey: body.server_key ?? null,
          missionUidPattern: body.mission_uid_pattern ?? null,
          requirePresentAtEnd: body.require_present_at_end,
          includeStartedOperations: body.include_started_operations,
          grantMode: body.grant_mode
        })
        .returning(discordAttendanceRuleReturning);

      return { ok: true, rule: result[0] };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create Discord attendance rule");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/discord/guilds/:guild_id/rules/:rule_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = ruleParamsSchema.safeParse(request.params);
    const parsedBody = rulePatchSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;
    const ruleId = parsedParams.data.rule_id;

    try {
      const currentResult = await getDrizzleDb()
        .select({
          id: discordAttendanceRules.id,
          guild_id: discordAttendanceRules.guildId,
          role_id: discordAttendanceRules.roleId,
          name: discordAttendanceRules.name,
          description: discordAttendanceRules.description,
          is_enabled: discordAttendanceRules.isEnabled,
          min_attendance_points: discordAttendanceRules.minAttendancePoints,
          min_operation_count: discordAttendanceRules.minOperationCount,
          min_attendance_percent: discordAttendanceRules.minAttendancePercent,
          lookback_days: discordAttendanceRules.lookbackDays,
          server_key: discordAttendanceRules.serverKey,
          mission_uid_pattern: discordAttendanceRules.missionUidPattern,
          require_present_at_end: discordAttendanceRules.requirePresentAtEnd,
          include_started_operations: discordAttendanceRules.includeStartedOperations,
          grant_mode: discordAttendanceRules.grantMode
        })
        .from(discordAttendanceRules)
        .where(and(eq(discordAttendanceRules.guildId, guildId), eq(discordAttendanceRules.id, ruleId)))
        .limit(1);
      const current = currentResult[0] as Record<string, unknown> | undefined;

      if (!current) {
        return reply.code(404).send({ ok: false, error: { code: "rule_not_found", message: "Discord attendance rule was not found." } });
      }

      const merged = { ...current, ...parsedBody.data };
      const nextRoleId = String(merged.role_id);

      if (!(await roleExists(guildId, nextRoleId))) {
        return reply.code(404).send({ ok: false, error: { code: "role_not_found", message: "Discord role was not found." } });
      }

      const result = await getDrizzleDb()
        .update(discordAttendanceRules)
        .set({
          roleId: nextRoleId,
          name: String(merged.name),
          description: merged.description === undefined ? null : String(merged.description),
          isEnabled: Boolean(merged.is_enabled),
          minAttendancePoints: Number(merged.min_attendance_points),
          minOperationCount: Number(merged.min_operation_count),
          minAttendancePercent: merged.min_attendance_percent === undefined || merged.min_attendance_percent === null ? null : String(merged.min_attendance_percent),
          lookbackDays: merged.lookback_days === undefined || merged.lookback_days === null ? null : Number(merged.lookback_days),
          serverKey: merged.server_key === undefined || merged.server_key === null ? null : String(merged.server_key),
          missionUidPattern: merged.mission_uid_pattern === undefined || merged.mission_uid_pattern === null ? null : String(merged.mission_uid_pattern),
          requirePresentAtEnd: Boolean(merged.require_present_at_end),
          includeStartedOperations: Boolean(merged.include_started_operations),
          grantMode: String(merged.grant_mode),
          updatedAt: sql`now()`
        })
        .where(and(eq(discordAttendanceRules.guildId, guildId), eq(discordAttendanceRules.id, ruleId)))
        .returning(discordAttendanceRuleReturning);

      return { ok: true, rule: result[0] };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update Discord attendance rule");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/discord/guilds/:guild_id/rules/:rule_id", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = ruleParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const result = await getDrizzleDb()
        .delete(discordAttendanceRules)
        .where(and(eq(discordAttendanceRules.guildId, parsedParams.data.guild_id), eq(discordAttendanceRules.id, parsedParams.data.rule_id)))
        .returning({ id: discordAttendanceRules.id });
      return { ok: true, deleted: result.length };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });
}
