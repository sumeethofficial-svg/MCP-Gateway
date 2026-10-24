import { createLogger, createMcpHttpServer, listen } from "@mcp-portal/mcp-kit";
import { registerCurrencyTools } from "./tools.js";

const log = createLogger("currency-mcp");
const token = process.env.MCP_AUTH_TOKEN;
const port = Number.parseInt(process.env.PORT ?? "8080", 10);

try {
  if (!token) throw new Error("Missing required environment variable MCP_AUTH_TOKEN");
  const server = createMcpHttpServer({
    name: "currency-mcp",
    version: "1.0.0",
    instructions: "Currency conversion for store prices and orders over an indicative sample rate table, with monthly history.",
    authToken: token,
    logger: log,
    registerTools: registerCurrencyTools,
  });
  await listen(server, port, log);
} catch (err) {
  log.fatal({ err: (err as Error).message }, "failed to start");
  process.exit(1);
}
