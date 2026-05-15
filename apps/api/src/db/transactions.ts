import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { getDbPool } from "./pool.js";

export type DbTransaction = {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
};

export async function withDbTransaction<T>(callback: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const client: PoolClient = await getDbPool().connect();

  try {
    await client.query("BEGIN");

    const result = await callback({
      query: (sql, values) => client.query(sql, values)
    });

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
