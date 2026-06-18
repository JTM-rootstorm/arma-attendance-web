import type { FastifyInstance } from "fastify";

import { queryDb } from "../../db/pool.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import { assignmentAuditsQuerySchema, requireAnyDiscordAdmin } from "./shared.js";

export async function registerDiscordAuditRoutes(app: FastifyInstance) {
  app.get("/v1/discord/assignment-audits", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply);

    if (!auth) {
      return;
    }

    const parsedQuery = assignmentAuditsQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [];
    const where: string[] = [];

    if (parsedQuery.data.user_id) {
      values.push(parsedQuery.data.user_id);
      where.push(`daa.user_id = $${values.length}::uuid`);
    }

    if (parsedQuery.data.player_uid) {
      values.push(parsedQuery.data.player_uid);
      where.push(`daa.player_uid = $${values.length}`);
    }

    if (parsedQuery.data.discord_user_id) {
      values.push(parsedQuery.data.discord_user_id);
      where.push(`daa.discord_user_id = $${values.length}`);
    }

    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb(
        `
        SELECT daa.*, au.display_name AS user_display_name, p.last_name AS player_name
        FROM discord_assignment_audits daa
        LEFT JOIN app_users au ON au.id = daa.user_id
        LEFT JOIN players p ON p.player_uid = daa.player_uid
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY daa.created_at DESC
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
