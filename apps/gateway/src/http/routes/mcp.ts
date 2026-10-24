import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Principal } from "../../auth/principal.js";
import type { Container } from "../../container.js";
import { createGatewayMcpServer, type GatewayMode } from "../../mcp/server.js";

const REASON_TEXT = {
  malformed: "Invalid API key format",
  unknown: "Invalid API key",
  revoked: "This API key has been revoked",
  expired: "This API key has expired",
  user_disabled: "This account has been disabled",
} as const;

function rpcError(reply: FastifyReply, status: number, code: number, message: string, headers: Record<string, string> = {}) {
  void reply.headers(headers).status(status).type("application/json");
  return reply.send({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** The tool a rejected request was trying to reach, for the audit trail. */
function targetOf(body: unknown): string | undefined {
  const b = body as { method?: string; params?: { name?: string } } | undefined;
  return b?.method === "tools/call" ? b.params?.name : b?.method;
}

/**
 * The gateway's single public MCP endpoint. Clients authenticate with their own API key;
 * the key is checked against the database on every request so revocation is immediate.
 * The bearer token is used for authentication only. It is never forwarded to an upstream.
 */
export function mcpRoutes(app: FastifyInstance, c: Container): void {
  // Browser-based MCP clients call this endpoint cross-origin. The endpoint uses bearer tokens,
  // never cookies, so a wildcard origin does not expose any ambient credentials.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/mcp")) return;
    reply.raw.setHeader("access-control-allow-origin", "*");
    reply.raw.setHeader("access-control-expose-headers", "mcp-session-id, www-authenticate");
    if (req.method === "OPTIONS") {
      reply.raw.setHeader("access-control-allow-methods", "POST, OPTIONS");
      reply.raw.setHeader("access-control-allow-headers", "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id");
      reply.raw.setHeader("access-control-max-age", "600");
      return reply.status(204).send();
    }
  });

  async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<Principal | undefined> {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const challenge = { "www-authenticate": 'Bearer realm="mcp-portal-mcp"' };
    if (!match) {
      c.metrics.authFailures.inc({ reason: "missing" });
      rpcError(reply, 401, -32001, "Missing API key. Send 'Authorization: Bearer <your key>'. Create a key in the dashboard.", challenge);
      return undefined;
    }
    const result = await c.auth.authenticateApiKey(match[1]!);
    if (result.ok) return result.principal;

    c.metrics.authFailures.inc({ reason: result.reason });
    if ("owner" in result) {
      // A genuine key that is no longer valid. Record the attempt against its owner so the
      // audit trail shows, for example, a revoked key still being used.
      await c.audit
        .record({
          requestId: req.id,
          principal: result.owner,
          clientName: req.headers["user-agent"],
          exposedName: targetOf(req.body),
          outcome: "denied",
          errorMessage: REASON_TEXT[result.reason],
          durationMs: 0,
        })
        .catch((err) => c.log.error({ err: (err as Error).message }, "failed to audit rejected key"));
    }
    rpcError(reply, 401, -32001, REASON_TEXT[result.reason], challenge);
    return undefined;
  }

  async function serve(req: FastifyRequest, reply: FastifyReply, mode: GatewayMode): Promise<void> {
    const principal = await authenticate(req, reply);
    if (!principal) return;

    const server = createGatewayMcpServer(c.gateway, principal, { mode, requestId: req.id, clientName: req.headers["user-agent"] });
    // Stateless: a fresh server and transport per request, nothing kept between requests, so any
    // replica can answer any request and a restart loses nothing.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  app.post("/mcp", (req, reply) => serve(req, reply, "full"));
  app.post("/mcp/lazy", (req, reply) => serve(req, reply, "lazy"));

  const notAllowed = (_req: FastifyRequest, reply: FastifyReply) =>
    rpcError(reply, 405, -32000, "Method not allowed. This gateway is stateless Streamable HTTP and accepts POST only.", { allow: "POST, OPTIONS" });
  for (const path of ["/mcp", "/mcp/lazy"]) {
    app.get(path, notAllowed);
    app.delete(path, notAllowed);
  }
}
