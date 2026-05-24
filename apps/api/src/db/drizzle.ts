import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool } from "./pool.js";
import * as schema from "./schema/index.js";

export function getDrizzleDb() {
  return drizzle({ client: getDbPool(), schema });
}
