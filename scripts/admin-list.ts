#!/usr/bin/env tsx
import { closeDbPool, queryDb } from "../apps/api/src/db/pool.js";

type UserRow = {
  id: string;
  display_name: string | null;
  disabled_at: Date | null;
  last_login_at: Date | null;
  roles: string[] | null;
  identities: Array<{ provider: string; provider_user_id: string; display_name: string | null }> | null;
};

function formatDate(value: Date | null): string {
  return value ? value.toISOString() : "never";
}

async function main() {
  const result = await queryDb<UserRow>(
    `
    SELECT
      au.id,
      au.display_name,
      au.disabled_at,
      au.last_login_at,
      COALESCE(array_agg(DISTINCT ur.role) FILTER (WHERE ur.role IS NOT NULL), ARRAY[]::text[]) AS roles,
      COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
          'provider', ui.provider,
          'provider_user_id', ui.provider_user_id,
          'display_name', ui.display_name
        )) FILTER (WHERE ui.id IS NOT NULL),
        '[]'::jsonb
      ) AS identities
    FROM app_users au
    LEFT JOIN user_roles ur ON ur.user_id = au.id
    LEFT JOIN user_identities ui ON ui.user_id = au.id
    GROUP BY au.id
    ORDER BY au.created_at DESC
    `
  );

  for (const user of result.rows) {
    const roles = (user.roles ?? []).join(",") || "none";
    const identities =
      user.identities?.map((identity) => `${identity.provider}:${identity.provider_user_id}`).join(", ") || "none";
    const status = user.disabled_at ? `disabled ${formatDate(user.disabled_at)}` : "enabled";

    console.log(`${user.id} | ${user.display_name ?? "unnamed"} | roles=${roles} | identities=${identities} | ${status} | last_login=${formatDate(user.last_login_at)}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDbPool();
  });
