import { createLogger } from "@mcp-portal/mcp-kit";
import { loadConfig } from "./config.js";
import { cliHelm } from "./helm.js";
import { inClusterKube } from "./kube.js";
import { StoreManager } from "./manager.js";
import { createApi } from "./server.js";

const log = createLogger("provisioner");

try {
  const config = loadConfig();
  const manager = new StoreManager(inClusterKube(), cliHelm(config.helmBin), config, log);
  const server = createApi(manager, config.token, log);
  server.listen(config.port, "0.0.0.0", () => {
    log.info({ port: config.port, prefix: config.nsPrefix, maxPerUser: config.maxPerUser, maxTotal: config.maxTotal }, "provisioner listening");
    manager.start();
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close();
    void manager.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} catch (err) {
  log.fatal({ err: (err as Error).message }, "failed to start");
  process.exit(1);
}
