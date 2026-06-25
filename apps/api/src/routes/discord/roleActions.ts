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

    try {
      const result = await queryDb<{ updated: number; failed_to_match: number }>(
        `
        WITH input AS (
          SELECT
            ord,
            NULLIF(value->>'audit_id', '')::uuid AS audit_id,
            NULLIF(value->>'player_uid', '') AS player_uid,
            NULLIF(value->>'discord_user_id', '') AS discord_user_id,
            value->>'role_id' AS role_id,
            value->>'action' AS action,
            value->>'status' AS status,
            NULLIF(value->>'error_message', '') AS error_message
          FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS item(value, ord)
        ),
        matches AS (
          SELECT DISTINCT i.ord, audit.id, i.status, i.error_message
          FROM input i
          JOIN discord_role_action_audits audit
            ON audit.guild_id = $1
            AND audit.evaluation_id = $2::uuid
            AND (i.audit_id IS NULL OR audit.id = i.audit_id)
            AND (i.player_uid IS NULL OR audit.player_uid = i.player_uid)
            AND (i.discord_user_id IS NULL OR audit.discord_user_id = i.discord_user_id)
            AND audit.role_id = i.role_id
            AND audit.action = i.action
        ),
        updated AS (
          UPDATE discord_role_action_audits audit
          SET status = matches.status,
              error_message = matches.error_message,
              reported_at = now()
          FROM matches
          WHERE audit.id = matches.id
          RETURNING matches.ord
        )
        SELECT
          (SELECT COUNT(*)::int FROM updated) AS updated,
          (
            (SELECT COUNT(*)::int FROM input)
            - (SELECT COUNT(DISTINCT ord)::int FROM updated)
          ) AS failed_to_match
        `,
        [parsedParams.data.guild_id, parsedBody.data.evaluation_id, JSON.stringify(parsedBody.data.results)]
      );
      const updated = result.rows[0]?.updated ?? 0;
      const failedToMatch = result.rows[0]?.failed_to_match ?? parsedBody.data.results.length;

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
