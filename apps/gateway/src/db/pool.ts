import { Pool, type PoolClient } from "pg";

export type Db = Pool;

export function createPool(connectionString: string, max = 10): Db {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // An idle client erroring (e.g. Postgres restarting) must not crash the process.
  pool.on("error", () => {});
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Waits for the database to accept connections; pods often start before Postgres is ready (on a cold node its image pull alone can take minutes). */
export async function waitForDb(db: Db, attempts = 180, delayMs = 1000): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Database not reachable: ${(lastError as Error)?.message ?? "unknown error"}`);
}
