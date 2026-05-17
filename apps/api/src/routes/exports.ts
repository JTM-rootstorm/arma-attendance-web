import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireBearerToken } from "../auth.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { queryDb } from "../db/pool.js";

const operationParamsSchema = z.object({
  operation_id: z.string().uuid()
});

const playersCsvQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500)
});

type AttendanceCsvRow = {
  operation_id: string;
  player_uid: string;
  name_at_start: string | null;
  name_at_end: string | null;
  present_at_start: boolean;
  present_at_end: boolean;
  side_at_start: string | null;
  side_at_end: string | null;
  group_at_start: string | null;
  group_at_end: string | null;
  role_at_start: string | null;
  role_at_end: string | null;
  infantry_kills: number | null;
  vehicle_kills: number | null;
  player_kills: number | null;
  ai_kills: number | null;
  friendly_kills: number | null;
  deaths: number | null;
};

type PlayerCsvRow = {
  player_uid: string;
  last_name: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  operation_count: number;
  total_ai_kills: number;
  total_deaths: number;
};

function sendValidationFailed(reply: FastifyReply) {
  return reply.code(400).send({
    ok: false,
    error: {
      code: "validation_failed",
      message: "Request did not match expected shape."
    }
  });
}

function sendDatabaseUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: {
      code: "database_unavailable",
      message: "Database is not available."
    }
  });
}

function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = value instanceof Date ? value.toISOString() : String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [
    headers.map(formatCsvValue).join(","),
    ...rows.map((row) => headers.map((header) => formatCsvValue(row[header])).join(","))
  ];

  return `${lines.join("\n")}\n`;
}

export async function registerExportRoutes(app: FastifyInstance) {
  app.get("/v1/operations/:operation_id/attendance.csv", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsedParams = operationParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const { operation_id: operationId } = parsedParams.data;

    try {
      const operationResult = await queryDb<{ id: string }>("SELECT id FROM operations WHERE id = $1", [operationId]);

      if (!operationResult.rows[0]) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "operation_not_found",
            message: "Operation was not found."
          }
        });
      }

      const attendanceResult = await queryDb<AttendanceCsvRow>(
        `
        SELECT
          op.operation_id,
          op.player_uid,
          op.name_at_start,
          op.name_at_end,
          op.present_at_start,
          op.present_at_end,
          op.side_at_start,
          op.side_at_end,
          op.group_at_start,
          op.group_at_end,
          op.role_at_start,
          op.role_at_end,
          COALESCE(ops.infantry_kills, 0)::int AS infantry_kills,
          COALESCE(ops.vehicle_kills, 0)::int AS vehicle_kills,
          COALESCE(ops.player_kills, 0)::int AS player_kills,
          COALESCE(ops.ai_kills, 0)::int AS ai_kills,
          COALESCE(ops.friendly_kills, 0)::int AS friendly_kills,
          COALESCE(ops.deaths, 0)::int AS deaths
        FROM operation_players op
        LEFT JOIN operation_player_stats ops
          ON ops.operation_id = op.operation_id
          AND ops.player_uid = op.player_uid
        WHERE op.operation_id = $1
        ORDER BY COALESCE(op.name_at_end, op.name_at_start, op.player_uid), op.player_uid
        `,
        [operationId]
      );

      const headers = [
        "operation_id",
        "player_uid",
        "name_at_start",
        "name_at_end",
        "present_at_start",
        "present_at_end",
        "side_at_start",
        "side_at_end",
        "group_at_start",
        "group_at_end",
        "role_at_start",
        "role_at_end",
        "infantry_kills",
        "vehicle_kills",
        "player_kills",
        "ai_kills",
        "friendly_kills",
        "deaths"
      ];

      return reply
        .type("text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="operation-${operationId}-attendance.csv"`)
        .send(toCsv(headers, attendanceResult.rows));
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to export operation attendance CSV");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/players.csv", { preHandler: requireBearerToken }, async (request, reply) => {
    const parsedQuery = playersCsvQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const query = parsedQuery.data;
    const values: unknown[] = [];
    let whereClause = "";

    if (query.q && query.q.trim().length > 0) {
      values.push(`%${query.q.trim()}%`);
      whereClause = `WHERE p.player_uid ILIKE $${values.length} OR p.last_name ILIKE $${values.length}`;
    }

    values.push(query.limit);
    const limitParam = values.length;

    try {
      const playersResult = await queryDb<PlayerCsvRow>(
        `
        SELECT
          p.player_uid,
          p.last_name,
          p.first_seen_at,
          p.last_seen_at,
          COUNT(DISTINCT op.operation_id)::int AS operation_count,
          COALESCE(SUM(ops.ai_kills), 0)::int AS total_ai_kills,
          COALESCE(SUM(ops.deaths), 0)::int AS total_deaths
        FROM players p
        LEFT JOIN operation_players op ON op.player_uid = p.player_uid
        LEFT JOIN operation_player_stats ops
          ON ops.operation_id = op.operation_id
          AND ops.player_uid = op.player_uid
        ${whereClause}
        GROUP BY p.player_uid
        ORDER BY p.last_seen_at DESC, p.player_uid
        LIMIT $${limitParam}
        `,
        values
      );

      const headers = [
        "player_uid",
        "last_name",
        "first_seen_at",
        "last_seen_at",
        "operation_count",
        "total_ai_kills",
        "total_deaths"
      ];

      return reply
        .type("text/csv; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="players.csv"')
        .send(toCsv(headers, playersResult.rows));
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to export players CSV");
      return sendDatabaseUnavailable(reply);
    }
  });
}
