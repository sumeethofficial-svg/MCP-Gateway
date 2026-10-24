import { pino } from "pino";
import { loadConfig } from "./config.js";
import { createContainer } from "./container.js";
import { createPool, waitForDb } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { buildApp } from "./http/app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie"] });

  const db = createPool(config.databaseUrl);
  await waitForDb(db);
  await migrate(db, log);

  const c = createContainer(config, log, db);
  if (config.bootstrapAdmin && (await c.auth.bootstrapAdmin(config.bootstrapAdmin.email, config.bootstrapAdmin.password))) {
    log.info({ email: config.bootstrapAdmin.email }, "created bootstrap admin");
  }
  await c.registry.seed(config.upstream.seeded);

  const app = await buildApp(c);
  c.health.start();
  c.stores?.start();
  await app.listen({ host: "0.0.0.0", port: config.port });
  log.info({ port: config.port, publicUrl: config.publicUrl }, "gateway listening");

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    c.health.stop();
    c.stores?.stop();
    await app.close();
    await c.pool.close();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
