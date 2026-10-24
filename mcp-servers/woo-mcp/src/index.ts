import { createLogger, createMcpHttpServer, listen } from "@mcp-portal/mcp-kit";
import { loadConfig } from "./config.js";
import { registerWooTools } from "./tools.js";
import { WooClient } from "./woo-client.js";

const log = createLogger("woo-mcp");

try {
  const config = loadConfig();
  const client = new WooClient(config);

  const server = createMcpHttpServer({
    name: "woo-mcp",
    version: "1.0.0",
    instructions: `Tools for the WooCommerce store "${config.storeName}". Prices and totals are strings in the store currency.`,
    authToken: config.authToken,
    logger: log,
    // Ready only when WordPress answers an authenticated REST call, so the gateway
    // never routes to a server that cannot reach (or authenticate to) the store.
    ready: () => client.reachable(),
    registerTools: (s) => registerWooTools(s, client, config, log),
  });

  await listen(server, config.port, log);
} catch (err) {
  log.fatal({ err: (err as Error).message }, "failed to start");
  process.exit(1);
}
