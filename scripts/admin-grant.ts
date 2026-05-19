#!/usr/bin/env tsx
import { closeDbPool, queryDb } from "../apps/api/src/db/pool.js";

const roles = ["owner", "tcw_admin", "admin", "officer", "viewer"] as const;
type Role = (typeof roles)[number];

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      continue;
    }

    args[key.slice(2)] = value;
    index += 1;
  }

  return args;
}

function usage(): never {
  console.error(
    "Usage: pnpm admin:grant -- --role owner|tcw_admin|admin|officer|viewer (--user-id <uuid> | --provider discord|steam --provider-user-id <id>)"
  );
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const role = args.role as Role | undefined;

  if (!role || !roles.includes(role)) {
    usage();
  }

  let userId = args["user-id"];
  const provider = args.provider;
  const providerUserId = args["provider-user-id"];

  if (!userId) {
    if (!provider || !providerUserId || !["discord", "steam"].includes(provider)) {
      usage();
    }

    const identity = await queryDb<{ user_id: string }>(
      "SELECT user_id FROM user_identities WHERE provider = $1 AND provider_user_id = $2",
      [provider, providerUserId]
    );
    userId = identity.rows[0]?.user_id;
  }

  if (!userId) {
    console.error("No matching user found.");
    process.exit(1);
  }

  const user = await queryDb<{ id: string; display_name: string | null }>("SELECT id, display_name FROM app_users WHERE id = $1", [
    userId
  ]);
  const row = user.rows[0];

  if (!row) {
    console.error("User does not exist.");
    process.exit(1);
  }

  await queryDb(
    `
    INSERT INTO user_roles (user_id, role, grant_source)
    VALUES ($1, $2, 'cli')
    ON CONFLICT (user_id, role) DO UPDATE
    SET grant_source = EXCLUDED.grant_source,
        granted_at = now()
    `,
    [userId, role]
  );
  await queryDb(
    `
    INSERT INTO admin_audit_events (actor_label, action, target_user_id, details)
    VALUES ('system/cli', 'grant_role', $1, $2::jsonb)
    `,
    [
      userId,
      JSON.stringify({
        role,
        ...(provider && providerUserId ? { provider, provider_user_id: providerUserId } : {})
      })
    ]
  );

  console.log(`Granted ${role} to ${row.display_name ?? row.id} (${row.id}).`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDbPool();
  });
