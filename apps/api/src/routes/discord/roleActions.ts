import type { FastifyInstance } from "fastify";

import { evaluateDiscordRoleActions } from "../../discord/scoring.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { queryDb } from "../../db/pool.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import {
  auditsQuerySchema,
  guildExists,
  guildParamsSchema,
  requireAnyDiscordAdmin,
  roleActionResultsBodySchema,
  roleActionsQuerySchema
} from "./shared.js";

export async function registerDiscordRoleActionRoutes(app: FastifyInstance) {
  app.get("/v1/discord/guilds/:guild_id/role-actions", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedQuery = roleActionsQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    try {
      if (!(await guildExists(parsedParams.data.guild_id))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      const evaluation = await evaluateDiscordRoleActions(parsedParams.data.guild_id, parsedQuery.data.persist);

      return {
        ok: true,
        guild_id: parsedParams.data.guild_id,
        evaluation_id: evaluation.evaluation_id,
        dry_run: parsedQuery.data.dry_run,
        actions: evaluation.actions,
        skipped: evaluation.skipped,
        summary: evaluation.summary
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to evaluate Discord role actions");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/role-action-results", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = roleActionResultsBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    let updated = 0;
    let failedToMatch = 0;

    try {
      for (const result of parsedBody.data.results) {
        const values = [
          parsedParams.data.guild_id,
          parsedBody.data.evaluation_id,
          result.audit_id ?? null,
          result.player_uid ?? null,
          result.discord_user_id ?? null,
          result.role_id,
          result.action,
          result.status,
          result.error_message ?? null
        ];
        const updateResult = await queryDb(
          `
          UPDATE discord_role_action_audits
          SET status = $8, error_message = $9, reported_at = now()
          WHERE guild_id = $1
            AND evaluation_id = $2
            AND ($3::uuid IS NULL OR id = $3::uuid)
            AND ($4::text IS NULL OR player_uid = $4)
            AND ($5::text IS NULL OR discord_user_id = $5)
            AND role_id = $6
            AND action = $7
          `,
          values
        );

        if ((updateResult.rowCount ?? 0) > 0) {
          updated += updateResult.rowCount ?? 0;
        } else {
          failedToMatch += 1;
        }
      }

      return { ok: true, updated, failed_to_match: failedToMatch };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to report Discord role action results");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/discord/guilds/:guild_id/role-action-audits", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedQuery = auditsQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [parsedParams.data.guild_id];
    const where = ["guild_id = $1"];

    if (parsedQuery.data.evaluation_id) {
      values.push(parsedQuery.data.evaluation_id);
      where.push(`evaluation_id = $${values.length}`);
    }

    if (parsedQuery.data.player_uid) {
      values.push(parsedQuery.data.player_uid);
      where.push(`player_uid = $${values.length}`);
    }

    if (parsedQuery.data.discord_user_id) {
      values.push(parsedQuery.data.discord_user_id);
      where.push(`discord_user_id = $${values.length}`);
    }

    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb(
        `
        SELECT *
        FROM discord_role_action_audits
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return { ok: true, audits: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });
}
