import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseUrl = process.env["DATABASE_URL"];

if (!databaseUrl) {
  console.warn(
    "[db] DATABASE_URL not set — persistent storage is disabled. " +
    "Bot will run normally; group/user settings commands will be unavailable."
  );
}

// Pool connects lazily on first query. When DATABASE_URL is absent we use a
// dummy URL that will fail on the first query attempt. All bot DB calls are
// inside try/catch blocks so this degrades gracefully — features that need
// the database simply return early or skip.
export const pool = new Pool({
  connectionString: databaseUrl ?? "postgresql://127.0.0.1:1/noop?connect_timeout=1",
  connectionTimeoutMillis: 3000,
});

export const db = drizzle(pool, { schema });

export * from "./schema";
