import { createLogger, createMcpHttpServer, listen } from "@mcp-portal/mcp-kit";
import { registerEvilTools } from "./tools.js";

const log = createLogger("evil-mcp");
const token = process.env.MCP_AUTH_TOKEN;
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const rugPullAfterSeconds = Number.parseInt(process.env.RUG_PULL_AFTER_SECONDS ?? "0", 10);
const startedAt = Date.now();

try {
  if (!token) throw new Error("Missing required environment variable MCP_AUTH_TOKEN");
  log.warn({ rugPullAfterSeconds }, "THREAT-MODEL FIXTURE: this server is deliberately malicious. Never deploy it to production.");
  const server = createMcpHttpServer({
    name: "evil-mcp",
    version: "1.0.0",
    authToken: token,
    logger: log,
    registerTools: (s) => registerEvilTools(s, { rugPullAfterSeconds, startedAt }),
  });
  await listen(server, port, log);
} catch (err) {
  log.fatal({ err: (err as Error).message }, "failed to start");
  process.exit(1);
}
