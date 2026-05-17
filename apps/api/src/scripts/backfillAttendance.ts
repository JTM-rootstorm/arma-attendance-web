import { closeDbPool, queryDb } from "../db/pool.js";
import { withDbTransaction } from "../db/transactions.js";
import { persistOperationAttendance } from "../normalization/operationAttendance.js";

type OperationPayloadBackfillRow = {
  operation_id: string;
  request_id: string;
  kind: "start" | "finish";
  payload: unknown;
  received_at: Date;
};

type BackfillOptions = {
  dryRun: boolean;
  operationId: string | null;
};

function parseArgs(argv: string[]): BackfillOptions {
  let dryRun = false;
  let operationId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--operation-id") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("--operation-id requires a UUID value.");
      }

      operationId = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun, operationId };
}

async function fetchPayloads(operationId: string | null): Promise<OperationPayloadBackfillRow[]> {
  const values: unknown[] = [];
  let whereClause = "";

  if (operationId) {
    values.push(operationId);
    whereClause = "WHERE operation_id = $1";
  }

  const result = await queryDb<OperationPayloadBackfillRow>(
    `
    SELECT operation_id, request_id, kind, payload, received_at
    FROM operation_payloads
    ${whereClause}
    ORDER BY received_at ASC, id ASC
    `,
    values
  );

  return result.rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payloads = await fetchPayloads(options.operationId);

  console.log(
    `[db:backfill:attendance] payloads=${payloads.length} dry_run=${options.dryRun ? "true" : "false"}${
      options.operationId ? ` operation_id=${options.operationId}` : ""
    }`
  );

  for (const payload of payloads) {
    if (options.dryRun) {
      console.log(
        `[db:backfill:attendance] dry-run operation_id=${payload.operation_id} request_id=${payload.request_id} phase=${payload.kind}`
      );
      continue;
    }

    const summary = await withDbTransaction((tx) =>
      persistOperationAttendance(tx, payload.operation_id, payload.kind, payload.payload)
    );

    console.log(
      `[db:backfill:attendance] operation_id=${payload.operation_id} request_id=${payload.request_id} phase=${payload.kind} players_seen=${summary.players_seen} players_ignored_missing_uid=${summary.players_ignored_missing_uid} stats_seen=${summary.stats_seen}`
    );
  }

  console.log("[db:backfill:attendance] OK");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[db:backfill:attendance] failed: ${message}`);
  process.exitCode = 1;
} finally {
  await closeDbPool();
}
