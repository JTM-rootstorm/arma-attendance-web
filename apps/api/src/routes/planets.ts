import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireRole, requireUser } from "../auth.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { adminAuditEvents } from "../db/schema/auth.js";
import { planets } from "../db/schema/planets.js";

const planetSlugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const planetPercentPattern = /^(?:100(?:\.000)?|(?:\d|[1-9]\d)(?:\.\d{1,3})?)$/;

const planetParamsSchema = z.object({
  planet_id: z.string().uuid()
});

const publicPlanetParamsSchema = z.object({
  slug: z.string().regex(planetSlugPattern)
});

const listPlanetsQuerySchema = z.object({
  include_inactive: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

const planetPercentSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const raw = typeof value === "number" ? value.toFixed(3) : value.trim();

  if (!planetPercentPattern.test(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a percentage from 0.000 through 100.000."
    });
    return z.NEVER;
  }

  return Number(raw).toFixed(3);
});

const createPlanetSchema = z.object({
  slug: z.string().trim().regex(planetSlugPattern),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  completion_percent: planetPercentSchema.default("0.000"),
  display_order: z.coerce.number().int().min(-1_000_000).max(1_000_000).default(0),
  is_active: z.coerce.boolean().default(true)
});

const updatePlanetSchema = z
  .object({
    slug: z.string().trim().regex(planetSlugPattern).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    completion_percent: planetPercentSchema.optional(),
    display_order: z.coerce.number().int().min(-1_000_000).max(1_000_000).optional(),
    is_active: z.coerce.boolean().optional()
  })
  .refine(
    (value) =>
      value.slug !== undefined ||
      value.name !== undefined ||
      value.description !== undefined ||
      value.completion_percent !== undefined ||
      value.display_order !== undefined ||
      value.is_active !== undefined
  );

type PlanetRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  completion_percent: string;
  display_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

type PublicPlanetRow = Pick<PlanetRow, "slug" | "name" | "description" | "completion_percent" | "updated_at">;

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

function isUniqueViolation(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
    return true;
  }

  if (typeof error === "object" && error !== null && "cause" in error) {
    return isUniqueViolation((error as { cause?: unknown }).cause);
  }

  return false;
}

function sendDuplicatePlanet(reply: FastifyReply) {
  return reply.code(409).send({
    ok: false,
    error: {
      code: "planet_exists",
      message: "A planet already exists for that slug."
    }
  });
}

function planetReturningColumns() {
  return {
    id: planets.id,
    slug: planets.slug,
    name: planets.name,
    description: planets.description,
    completion_percent: planets.completionPercent,
    display_order: planets.displayOrder,
    is_active: planets.isActive,
    created_at: planets.createdAt,
    updated_at: planets.updatedAt
  };
}

function publicPlanetReturningColumns() {
  return {
    slug: planets.slug,
    name: planets.name,
    description: planets.description,
    completion_percent: planets.completionPercent,
    updated_at: planets.updatedAt
  };
}

function serializePlanet(row: PlanetRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    completion_percent: Number(row.completion_percent).toFixed(3),
    display_order: row.display_order,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function serializePublicPlanet(row: PublicPlanetRow) {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    completion_percent: Number(row.completion_percent).toFixed(3),
    updated_at: row.updated_at
  };
}

async function listPublicPlanets(reply: FastifyReply) {
  const db = getDrizzleDb();
  const rows = await db
    .select(publicPlanetReturningColumns())
    .from(planets)
    .where(eq(planets.isActive, true))
    .orderBy(asc(planets.displayOrder), asc(planets.name));

  reply.header("Cache-Control", "public, max-age=60");
  return {
    ok: true,
    planets: rows.map(serializePublicPlanet)
  };
}

export async function registerPlanetRoutes(app: FastifyInstance) {
  app.get("/public/planets", async (_request, reply) => {
    try {
      return await listPublicPlanets(reply);
    } catch (error) {
      _request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list public planets");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/public/planets/all", async (_request, reply) => {
    try {
      return await listPublicPlanets(reply);
    } catch (error) {
      _request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list public planets");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/public/planets/:slug", async (request, reply) => {
    const parsedParams = publicPlanetParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    try {
      const db = getDrizzleDb();
      const [planet] = await db
        .select(publicPlanetReturningColumns())
        .from(planets)
        .where(and(eq(planets.slug, parsedParams.data.slug), eq(planets.isActive, true)))
        .limit(1);

      if (!planet) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "planet_not_found",
            message: "Planet was not found."
          }
        });
      }

      reply.header("Cache-Control", "public, max-age=60");
      return {
        ok: true,
        planet: serializePublicPlanet(planet)
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to fetch public planet");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/v1/system/planets", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedQuery = listPlanetsQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    try {
      const db = getDrizzleDb();
      const rows = await db
        .select(planetReturningColumns())
        .from(planets)
        .where(parsedQuery.data.include_inactive ? undefined : eq(planets.isActive, true))
        .orderBy(asc(planets.displayOrder), asc(planets.name))
        .limit(parsedQuery.data.limit)
        .offset(parsedQuery.data.offset);

      return {
        ok: true,
        planets: rows.map(serializePlanet),
        pagination: {
          limit: parsedQuery.data.limit,
          offset: parsedQuery.data.offset,
          count: rows.length
        }
      };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to list planets");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/system/planets", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedBody = createPlanetSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    try {
      const db = getDrizzleDb();
      const planet = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(planets)
          .values({
            slug: parsedBody.data.slug,
            name: parsedBody.data.name,
            description: parsedBody.data.description ?? null,
            completionPercent: parsedBody.data.completion_percent,
            displayOrder: parsedBody.data.display_order,
            isActive: parsedBody.data.is_active,
            createdByUserId: actor.id
          })
          .returning(planetReturningColumns());

        if (!row) {
          throw new Error("Planet insert returned no rows.");
        }

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "planet_created",
          details: {
            planet_id: row.id,
            slug: row.slug,
            completion_percent: row.completion_percent
          }
        });

        return row;
      });

      return { ok: true, planet: serializePlanet(planet) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return sendDuplicatePlanet(reply);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to create planet");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.patch("/v1/system/planets/:planet_id", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = planetParamsSchema.safeParse(request.params);
    const parsedBody = updatePlanetSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    try {
      const db = getDrizzleDb();
      const planet = await db.transaction(async (tx) => {
        const updateValues: {
          slug?: string;
          name?: string;
          description?: string | null;
          completionPercent?: string;
          displayOrder?: number;
          isActive?: boolean;
          updatedAt: Date;
        } = {
          updatedAt: new Date()
        };

        if (parsedBody.data.slug !== undefined) {
          updateValues.slug = parsedBody.data.slug;
        }

        if (parsedBody.data.name !== undefined) {
          updateValues.name = parsedBody.data.name;
        }

        if (parsedBody.data.description !== undefined) {
          updateValues.description = parsedBody.data.description;
        }

        if (parsedBody.data.completion_percent !== undefined) {
          updateValues.completionPercent = parsedBody.data.completion_percent;
        }

        if (parsedBody.data.display_order !== undefined) {
          updateValues.displayOrder = parsedBody.data.display_order;
        }

        if (parsedBody.data.is_active !== undefined) {
          updateValues.isActive = parsedBody.data.is_active;
        }

        const [row] = await tx
          .update(planets)
          .set(updateValues)
          .where(eq(planets.id, parsedParams.data.planet_id))
          .returning(planetReturningColumns());

        if (!row) {
          return null;
        }

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "planet_updated",
          details: {
            planet_id: row.id,
            slug: row.slug,
            completion_percent: row.completion_percent,
            is_active: row.is_active
          }
        });

        return row;
      });

      if (!planet) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "planet_not_found",
            message: "Planet was not found."
          }
        });
      }

      return { ok: true, planet: serializePlanet(planet) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return sendDuplicatePlanet(reply);
      }

      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to update planet");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.delete("/v1/system/planets/:planet_id", { preHandler: requireRole(["owner"]) }, async (request, reply) => {
    const parsedParams = planetParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return sendValidationFailed(reply);
    }

    const actor = await requireUser(request, reply);

    if (!actor) {
      return;
    }

    try {
      const db = getDrizzleDb();
      const planet = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(planets)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(planets.id, parsedParams.data.planet_id))
          .returning(planetReturningColumns());

        if (!row) {
          return null;
        }

        await tx.insert(adminAuditEvents).values({
          actorUserId: actor.id,
          actorLabel: actor.display_name ?? actor.id,
          action: "planet_deactivated",
          details: {
            planet_id: row.id,
            slug: row.slug
          }
        });

        return row;
      });

      if (!planet) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "planet_not_found",
            message: "Planet was not found."
          }
        });
      }

      return { ok: true, planet: serializePlanet(planet) };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to deactivate planet");
      return sendDatabaseUnavailable(reply);
    }
  });
}
