import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { config } from "../config.js";
import { getDrizzleDb } from "../db/drizzle.js";
import { getSafeDbErrorDetails } from "../db/errors.js";
import { players } from "../db/schema/players.js";
import { unitPlayers, unitRanks, unitRosterAssignments, unitSquads, units } from "../db/schema/units.js";

const publicSquadParamsSchema = z.object({
  unit_slug: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/)
});

const paaParamsSchema = publicSquadParamsSchema.extend({
  filename: z.string().min(5).max(120).regex(/^[A-Za-z0-9._-]+\.paa$/)
});

const SQUAD_DTD = `<!ELEMENT squad (name,email,web,picture,title,member*)>
<!ATTLIST squad nick CDATA #REQUIRED>
<!ELEMENT member (name,email,icq,remark)>
<!ATTLIST member id CDATA #REQUIRED nick CDATA #REQUIRED>
<!ELEMENT name (#PCDATA)>
<!ELEMENT email (#PCDATA)>
<!ELEMENT web (#PCDATA)>
<!ELEMENT picture (#PCDATA)>
<!ELEMENT title (#PCDATA)>
<!ELEMENT icq (#PCDATA)>
<!ELEMENT remark (#PCDATA)>
`;

const bundledSquadAssetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "squad-assets");

type StrictSquadUnit = {
  unit_key: string;
  name: string;
  display_name: string | null;
  callsign: string | null;
  squad_xml_title: string | null;
  squad_xml_web_url: string | null;
  squad_xml_picture_filename: string;
};

type StrictSquadMember = {
  player_uid: string;
  last_name: string | null;
  roster_name: string | null;
  rank: string | null;
  rank_name: string | null;
  squad_name: string | null;
  billet: string | null;
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

function notFound(reply: FastifyReply, code: string, message: string) {
  return reply.code(404).send({
    ok: false,
    error: { code, message }
  });
}

function xmlEscapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlEscapeAttribute(value: string): string {
  return xmlEscapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function fallbackText(value: string | null | undefined, fallback = "N/A"): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function simplePaaFilename(value: string | null | undefined, fallback: string): string {
  const candidate = fallbackText(value, fallback);
  return /^[A-Za-z0-9._-]+\.paa$/.test(candidate) ? candidate : fallback;
}

function memberRemark(row: StrictSquadMember): string {
  const parts = [row.rank_name ?? row.rank, row.squad_name, row.billet]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part && part.length > 0 && part !== "unassigned"));

  return parts.length > 0 ? parts.join(" / ") : "N/A";
}

function buildStrictSquadXml(input: { unit: StrictSquadUnit; members: StrictSquadMember[] }): string {
  const nick = fallbackText(input.unit.callsign ?? input.unit.unit_key, input.unit.unit_key);
  const unitName = fallbackText(input.unit.display_name ?? input.unit.name, input.unit.unit_key);
  const web = fallbackText(input.unit.squad_xml_web_url, config.publicBaseUrl);
  const picture = simplePaaFilename(input.unit.squad_xml_picture_filename, config.squadXmlDefaultPicture);
  const title = fallbackText(input.unit.squad_xml_title ?? input.unit.callsign ?? input.unit.unit_key, input.unit.unit_key);

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE squad SYSTEM "squad.dtd">`,
    `<squad nick="${xmlEscapeAttribute(nick)}">`,
    `  <name>${xmlEscapeText(unitName)}</name>`,
    `  <email>N/A</email>`,
    `  <web>${xmlEscapeText(web)}</web>`,
    `  <picture>${xmlEscapeText(picture)}</picture>`,
    `  <title>${xmlEscapeText(title)}</title>`
  ];

  for (const member of input.members) {
    const memberNick = fallbackText(member.roster_name ?? member.last_name ?? member.player_uid, member.player_uid);

    lines.push(
      `  <member id="${xmlEscapeAttribute(member.player_uid)}" nick="${xmlEscapeAttribute(memberNick)}">`,
      `    <name>N/A</name>`,
      `    <email>N/A</email>`,
      `    <icq>N/A</icq>`,
      `    <remark>${xmlEscapeText(memberRemark(member))}</remark>`,
      `  </member>`
    );
  }

  lines.push(`</squad>`, "");
  return lines.join("\n");
}

function safeAssetPath(rootPath: string, unitSlug: string, filename: string, useDefaultFolder = false): string | null {
  const root = resolve(rootPath);
  const folder = useDefaultFolder ? "_default" : unitSlug;
  const fullPath = resolve(join(root, folder, basename(filename)));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  return fullPath.startsWith(rootPrefix) ? fullPath : null;
}

async function firstReadablePath(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep trying fallbacks.
    }
  }

  return null;
}

async function findPublicUnit(unitSlug: string): Promise<(StrictSquadUnit & { id: string }) | null> {
  const db = getDrizzleDb();
  const selectUnit = {
    id: units.id,
    unit_key: units.unitKey,
    name: units.name,
    display_name: units.displayName,
    callsign: units.callsign,
    squad_xml_title: units.squadXmlTitle,
    squad_xml_web_url: units.squadXmlWebUrl,
    squad_xml_picture_filename: units.squadXmlPictureFilename
  };

  const slugMatches = await db
    .select(selectUnit)
    .from(units)
    .where(and(isNull(units.deletedAt), eq(units.isActive, true), eq(units.slug, unitSlug)))
    .limit(1);

  if (slugMatches[0]) {
    return slugMatches[0];
  }

  const keyMatches = await db
    .select(selectUnit)
    .from(units)
    .where(and(isNull(units.deletedAt), eq(units.isActive, true), eq(units.unitKey, unitSlug)))
    .limit(1);

  return keyMatches[0] ?? null;
}

async function listPublicMembers(unitId: string): Promise<StrictSquadMember[]> {
  const db = getDrizzleDb();

  return db
    .select({
      player_uid: unitPlayers.playerUid,
      last_name: players.lastName,
      roster_name: unitPlayers.rosterName,
      rank: unitPlayers.rank,
      rank_name: unitRanks.name,
      squad_name: unitSquads.name,
      billet: unitRosterAssignments.billet
    })
    .from(unitPlayers)
    .innerJoin(players, eq(players.playerUid, unitPlayers.playerUid))
    .leftJoin(unitRanks, eq(unitRanks.id, unitPlayers.rankId))
    .leftJoin(
      unitRosterAssignments,
      and(
        eq(unitRosterAssignments.unitId, unitPlayers.unitId),
        eq(unitRosterAssignments.playerUid, unitPlayers.playerUid),
        isNull(unitRosterAssignments.endedAt),
        eq(unitRosterAssignments.isPrimary, true)
      )
    )
    .leftJoin(unitSquads, eq(unitSquads.id, unitRosterAssignments.squadId))
    .where(and(eq(unitPlayers.unitId, unitId), eq(unitPlayers.isActive, true), ne(unitPlayers.rosterStatus, "inactive")))
    .orderBy(
      asc(unitPlayers.rankSort),
      asc(unitRanks.sortOrder),
      asc(unitRosterAssignments.sortOrder),
      asc(unitPlayers.rosterName),
      asc(players.lastName),
      asc(unitPlayers.playerUid)
    );
}

export async function registerSquadXmlRoutes(app: FastifyInstance) {
  app.get("/public/squads/:unit_slug/squad.dtd", async (request, reply) => {
    const parsed = publicSquadParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    return reply.type("application/xml-dtd; charset=utf-8").send(SQUAD_DTD);
  });

  app.get("/public/squads/:unit_slug/squad.xml", async (request, reply) => {
    const parsed = publicSquadParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    try {
      const unit = await findPublicUnit(parsed.data.unit_slug);
      if (!unit) {
        return notFound(reply, "unit_not_found", "Squad XML unit was not found.");
      }

      const members = await listPublicMembers(unit.id);
      return reply
        .type("application/xml; charset=utf-8")
        .header("Cache-Control", "public, max-age=300")
        .send(buildStrictSquadXml({ unit, members }));
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to generate strict squad XML");
      return sendDatabaseUnavailable(reply);
    }
  });

  app.get("/public/squads/:unit_slug/:filename", async (request, reply) => {
    const parsed = paaParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendValidationFailed(reply);
    }

    const { unit_slug: unitSlug, filename } = parsed.data;
    const unitPath = safeAssetPath(config.squadAssetRoot, unitSlug, filename);
    const configuredDefaultPath = safeAssetPath(config.squadAssetRoot, unitSlug, filename, true);
    const bundledUnitPath = safeAssetPath(bundledSquadAssetRoot, unitSlug, filename);
    const bundledDefaultPath = safeAssetPath(bundledSquadAssetRoot, unitSlug, filename, true);

    if (!unitPath || !configuredDefaultPath || !bundledUnitPath || !bundledDefaultPath) {
      return sendValidationFailed(reply);
    }

    const found = await firstReadablePath([unitPath, configuredDefaultPath, bundledUnitPath, bundledDefaultPath]);
    if (!found) {
      return notFound(reply, "paa_not_found", "Squad logo PAA was not found.");
    }

    return reply
      .type("application/octet-stream")
      .header("Cache-Control", "public, max-age=3600")
      .send(createReadStream(found));
  });
}
