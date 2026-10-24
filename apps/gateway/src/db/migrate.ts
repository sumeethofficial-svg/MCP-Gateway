import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { Db } from "./pool.js";

/** Arbitrary constant; all replicas contend for the same advisory lock. */
const MIGRATION_LOCK_ID = 727_274_001;

/**
 * Applies pending SQL migrations in filename order. A session-level advisory lock
 * serialises concurrent replicas, so rolling out several gateway pods at once is safe.
 */
export async function migrate(db: Db, log: Logger, dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      log.info({ migration: file }, "applied migration");
      applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}
