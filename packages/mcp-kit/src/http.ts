import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";

export interface McpHttpOptions {
  name: string;
  version: string;
  instructions?: string;
  /** Registers this server's tools. Called once per request (stateless mode). */
  registerTools: (server: McpServer) => void;
  /**
   * Bearer token callers must present on /mcp. This is the static credential an
   * admin stores in the gateway. Refusing to start without one is deliberate:
   * an upstream that trusts the network alone is one NetworkPolicy mistake away
   * from being public.
   */
  authToken?: string;
  /** Escape hatch for local experiments and tests only. */
  allowAnonymous?: boolean;
  /** Readiness probe. Throw to report not-ready (e.g. the backing store is down). */
  ready?: () => Promise<void>;
  logger: Logger;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1024 * 1024;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison that does not leak token length. */
export function tokensMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

class BodyTooLargeError extends Error {}

async function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Builds a stateless Streamable HTTP MCP server.
 *
 * Stateless means every POST gets a fresh McpServer + transport and nothing is
 * kept between requests. That makes the server trivially horizontally scalable
 * and means a restarted pod loses no session state.
 */
export function createMcpHttpServer(opts: McpHttpOptions): http.Server {
  if (!opts.authToken && !opts.allowAnonymous) {
    throw new Error(`${opts.name}: an auth token is required (set allowAnonymous only for local experiments)`);
  }
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const log = opts.logger;

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://internal");
    res.on("finish", () => {
      if (url.pathname !== "/healthz" && url.pathname !== "/readyz") {
        log.info({ method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started }, "request");
      }
    });

    try {
      if (url.pathname === "/healthz") return sendJson(res, 200, { status: "ok" });

      if (url.pathname === "/readyz") {
        try {
          await opts.ready?.();
          return sendJson(res, 200, { status: "ready" });
        } catch (err) {
          log.warn({ err: (err as Error).message }, "readiness check failed");
          return sendJson(res, 503, { status: "not-ready" });
        }
      }

      if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not found" });

      if (req.method !== "POST") {
        // Stateless server: no standalone SSE stream and no sessions to delete.
        return rpcError(res, 405, -32000, "Method not allowed; this server is stateless and accepts POST only", { allow: "POST" });
      }

      if (!opts.allowAnonymous) {
        const header = req.headers.authorization ?? "";
        const match = /^Bearer\s+(.+)$/i.exec(header);
        if (!match || !tokensMatch(match[1]!.trim(), opts.authToken!)) {
          return rpcError(res, 401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="mcp"' });
        }
      }

      let body: unknown;
      try {
        body = await readBody(req, maxBody);
      } catch (err) {
        if (err instanceof BodyTooLargeError) return rpcError(res, 413, -32600, "Request body too large");
        return rpcError(res, 400, -32700, "Parse error");
      }

      const server = new McpServer({ name: opts.name, version: opts.version }, { instructions: opts.instructions });
      opts.registerTools(server);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error({ err: (err as Error).message }, "unhandled request error");
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
      else res.end();
    }
  });
}

/** Starts the server and wires graceful shutdown for Kubernetes (SIGTERM on pod deletion). */
export function listen(server: http.Server, port: number, logger: Logger, host = "0.0.0.0"): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      logger.info({ port }, "listening");
      resolve();
    });
    const shutdown = (signal: string) => {
      logger.info({ signal }, "shutting down");
      server.close(() => process.exit(0));
      // Give in-flight requests a moment, then stop waiting on keep-alive sockets.
      setTimeout(() => process.exit(0), 8000).unref();
      server.closeIdleConnections();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
}
