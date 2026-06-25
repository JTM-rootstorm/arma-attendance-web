import type { FastifyInstance } from "fastify";

import { reconcileDiscordUsersWithConcurrency } from "../../discord/membershipResolver.js";
import { getSafeDbErrorDetails } from "../../db/errors.js";
import { queryDb } from "../../db/pool.js";
import { withDbTransaction } from "../../db/transactions.js";
import { sendDatabaseUnavailable, sendValidationFailed } from "../../http/responses.js";
import { guildExists, guildParamsSchema, memberSnapshotBodySchema, memberSnapshotQuerySchema, requireAnyDiscordAdmin } from "./shared.js";

const memberSnapshotChunkSize = 250;

export async function registerDiscordMemberSnapshotRoutes(app: FastifyInstance) {
  app.get("/v1/discord/guilds/:guild_id/member-snapshots", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedQuery = memberSnapshotQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
      return sendValidationFailed(reply);
    }

    const values: unknown[] = [parsedParams.data.guild_id];
    const where = ["dms.guild_id = $1"];
    if (parsedQuery.data.discord_user_id) {
      values.push(parsedQuery.data.discord_user_id);
      where.push(`dms.discord_user_id = $${values.length}`);
    }
    values.push(parsedQuery.data.limit);
    const limitParam = values.length;
    values.push(parsedQuery.data.offset);
    const offsetParam = values.length;

    try {
      const result = await queryDb(
        `
        SELECT dms.*, au.display_name AS user_display_name
        FROM discord_member_snapshots dms
        LEFT JOIN app_users au ON au.id = dms.user_id
        WHERE ${where.join(" AND ")}
        ORDER BY dms.last_seen_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
        `,
        values
      );

      return { ok: true, snapshots: result.rows };
    } catch (error) {
      return sendDatabaseUnavailable(reply);
    }
  });

  app.post("/v1/discord/guilds/:guild_id/member-snapshots", async (request, reply) => {
    const auth = await requireAnyDiscordAdmin(request, reply, true);

    if (!auth) {
      return;
    }

    const parsedParams = guildParamsSchema.safeParse(request.params);
    const parsedBody = memberSnapshotBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return sendValidationFailed(reply);
    }

    const guildId = parsedParams.data.guild_id;

    try {
      if (!(await guildExists(guildId))) {
        return reply.code(404).send({ ok: false, error: { code: "guild_not_found", message: "Discord guild was not found." } });
      }

      const members = parsedBody.data.members;
      await withDbTransaction(async (tx) => {
        for (let offset = 0; offset < members.length; offset += memberSnapshotChunkSize) {
          const chunk = members.slice(offset, offset + memberSnapshotChunkSize).map((member) => ({
            discord_user_id: member.discord_user_id,
            roles: member.roles,
            nick: member.nick ?? null,
            joined_at: member.joined_at ?? null,
            raw_member: member.raw_member ?? member
          }));

          await tx.query(
            `
            WITH incoming AS (
              SELECT *
              FROM jsonb_to_recordset($2::jsonb) AS member(
                discord_user_id text,
                roles jsonb,
                nick text,
                joined_at timestamptz,
                raw_member jsonb
              )
            )
            INSERT INTO discord_member_snapshots (
              guild_id,
              discord_user_id,
              role_ids,
              nick,
              joined_at,
              member_payload,
              source,
              last_seen_at
            )
            SELECT
              $1,
              incoming.discord_user_id,
              COALESCE(incoming.roles, '[]'::jsonb),
              incoming.nick,
              incoming.joined_at,
              COALESCE(incoming.raw_member, '{}'::jsonb),
              'bot_snapshot',
              now()
            FROM incoming
            ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET
              user_id = COALESCE(
                excluded.user_id,
                discord_member_snapshots.user_id,
                (
                  SELECT user_id
                  FROM user_identities
                  WHERE provider = 'discord'
                    AND provider_user_id = excluded.discord_user_id
                  ORDER BY last_seen_at DESC
                  LIMIT 1
                )
              ),
              role_ids = excluded.role_ids,
              nick = excluded.nick,
              joined_at = excluded.joined_at,
              member_payload = excluded.member_payload,
              source = excluded.source,
              last_seen_at = now(),
              last_error = NULL,
              updated_at = now()
            `,
            [guildId, JSON.stringify(chunk)]
          );
        }

        await tx.query(
          `
          UPDATE discord_guilds
          SET last_member_sync_at = now(), updated_at = now()
          WHERE guild_id = $1
          `,
          [guildId]
        );
      });

      const reconciled = parsedBody.data.reconcile
        ? await reconcileDiscordUsersWithConcurrency(
            members.map((member) => member.discord_user_id),
            "bot_snapshot"
          )
        : [];

      return { ok: true, guild_id: guildId, snapshots_upserted: parsedBody.data.members.length, reconciled };
    } catch (error) {
      request.log.error({ dbError: getSafeDbErrorDetails(error) }, "Failed to ingest Discord member snapshots");
      return sendDatabaseUnavailable(reply);
    }
  });
}
