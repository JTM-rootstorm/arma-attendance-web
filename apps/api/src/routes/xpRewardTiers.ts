import { asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireRole, requireUser } from "../auth.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { adminAuditEvents } from "../db/schema/auth.js";
import { xpRewardTiers } from "../db/schema/xpRewardTiers.js";

const tierParamsSchema = z.object({
  tier_id: z.string().uuid()
});

const listXpRewardTiersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

const createXpRewardTierSchema = z.object({
  mission_name_match: z.string().trim().min(1).max(200),
  xp_amount: z.coerce.number().int().min(1).max(1_000_000)
});

const updateXpRewardTierSchema = z
  .object({
    mission_name_match: z.string().trim().min(1).max(200).optional(),
    xp_amount: z.coerce.number().int().min(1).max(1_000_000).optional()
  })
  .refine((value) => value.mission_name_match !== undefined || value.xp_amount !== undefined);

type XpRewardTierRow = {
  id: string;
  mission_name_match: string;
  xp_amount: number;
  created_at: Date;
  updated_at: Date;
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

function sendDuplicateTier(reply: FastifyReply) {
  return reply.code(409).send({
    ok: false,
    error: {
      code: "xp_reward_tier_exists",
      message: "An XP reward tier already exists for that mission name match."
    }
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
    return true;
  }

  if (typeof error === "object" && error !== null && "cause" in error) {
    return isUniqueViolation((error as { cause?: unknown }).cause);
  }

  return false;
}

function serializeXpRewardTier(row: XpRewardTierRow) {
  return {
    id: row.id,
    mission_name_match: row.mission_name_match,
    xp_amount: row.xp_amount,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function tierReturningColumns() {
  return {
    id: xpRewardTiers.id,
    mission_name_match: xpRewardTiers.missionNameMatch,
    xp_amount: xpRewardTiers.xpAmount,
    created_at: xpRewardTiers.createdAt,
    updated_at: xpRewardTiers.updatedAt
  };
}

export async function registerXpRewardTierRoutes(app: FastifyInstance) {
  app.get("/v1/system/xp-reward-tiers", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedQuery = listXpRewardTiersQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    try {
      const db = getDrizzleDb();
      const rows = await db
        .select(tierReturningColumns())
        .from(xpRewardTiers)
        .orderBy(asc(xpRewardTiers.missionNameMatch), desc(xpRewardTiers.createdAt))
        .limit(parsedQuery.data.limit)
        .offset(parsedQuery.data.offset);

      return {
        ok: true,
        tiers: rows.map(serializeXpRewardTier),
        pagination: {
          limit: parsedQuery.data.limit,
          offset: parsedQuery.data.offset,
          count: rows.length
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list XP reward tiers");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/system/xp-reward-tiers", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedBody = createXpRewardTierSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    try {
      const db = getDrizzleDb();
      const tier = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(xpRewardTiers)
          .values({
            missionNameMatch: parsedBody.data.mission_name_match,
            xpAmount: parsedBody.data.xp_amount,
            createdByUserId: actor.id
          })
          .returning(tierReturningColumns());

        if (!row) {
          throw new Error("XP reward tier insert returned no rows.");
        }

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "xp_reward_tier_created",
          details: {
            tier_id: row.id,
            mission_name_match: row.mission_name_match,
            xp_amount: row.xp_amount
          }
        });

        return row;
      });

      return { ok: true, tier: serializeXpRewardTier(tier) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return sendDuplicateTier(reply);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create XP reward tier");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/system/xp-reward-tiers/:tier_id", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = tierParamsSchema.safeParse(request.params);
    const parsedBody = updateXpRewardTierSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    try {
      const db = getDrizzleDb();
      const tier = await db.transaction(async (tx) => {
        const updateValues: {
          missionNameMatch?: string;
          xpAmount?: number;
          updatedAt: Date | ReturnType<typeof sql>;
        } = {
          updatedAt: sql`now()`
        };

        if (parsedBody.data.mission_name_match !== undefined) {
          updateValues.missionNameMatch = parsedBody.data.mission_name_match;
        }

        if (parsedBody.data.xp_amount !== undefined) {
          updateValues.xpAmount = parsedBody.data.xp_amount;
        }

        const [row] = await tx
          .update(xpRewardTiers)
          .set(updateValues)
          .where(eq(xpRewardTiers.id, parsedParams.data.tier_id))
          .returning(tierReturningColumns());

        if (!row) {
          return null;
        }

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "xp_reward_tier_updated",
          details: {
            tier_id: row.id,
            mission_name_match: row.mission_name_match,
            xp_amount: row.xp_amount
          }
        });

        return row;
      });

      if (!tier) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "xp_reward_tier_not_found",
            message: "XP reward tier was not found."
          }
        });
      }

      return { ok: true, tier: serializeXpRewardTier(tier) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return sendDuplicateTier(reply);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update XP reward tier");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/system/xp-reward-tiers/:tier_id", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = tierParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    try {
      const db = getDrizzleDb();
      const tier = await db.transaction(async (tx) => {
        const [row] = await tx.delete(xpRewardTiers).where(eq(xpRewardTiers.id, parsedParams.data.tier_id)).returning(tierReturningColumns());

        if (!row) {
          return null;
        }

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "xp_reward_tier_deleted",
          details: {
            tier_id: row.id,
            mission_name_match: row.mission_name_match,
            xp_amount: row.xp_amount
          }
        });

        return row;
      });

      if (!tier) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "xp_reward_tier_not_found",
            message: "XP reward tier was not found."
          }
        });
      }

      return { ok: true, tier: serializeXpRewardTier(tier) };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to delete XP reward tier");
      return sendDatabaseUnavailable(reply);
    }
  });
}
