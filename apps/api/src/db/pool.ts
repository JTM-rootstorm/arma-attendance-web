import { Pool, type QueryResult, type QueryResultRow } from "pg";

import { config } from "../config.js";

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for database operations.");
  }

  pool ??= new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000
  });

  return pool;
}

export async function queryDb<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  return getDbPool().query<T>(sql, values);
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
