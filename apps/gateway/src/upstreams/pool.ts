import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { Agent, fetch as undiciFetch } from "undici";
import type { ConnectableUpstream } from "./registry.js";
import { createGuardedLookup, type SsrfPolicy } from "./ssrf.js";

export type UpstreamFailure = "timeout" | "unreachable" | "auth" | "protocol" | "circuit_open" | "blocked";

/** A failure talking to an upstream, with a message safe to show to a model or a user. */
export class UpstreamError extends Error {
  constructor(
    public readonly kind: UpstreamFailure,
    message: string,
    /** Whether this should count toward opening the circuit breaker. */
    public readonly trips = true,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface PoolOptions {
  connectTimeoutMs: number;
  listTimeoutMs: number;
  callTimeoutMs: number;
  breakerFailures: number;
  breakerCooldownMs: number;
  ssrf: SsrfPolicy;
}

class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  /** True while open. After the cooldown one trial request is let through (half-open). */
  isOpen(now = Date.now()): boolean {
    return now < this.openUntil;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  onFailure(now = Date.now()): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openUntil = now + this.cooldownMs;
  }

  get state(): "closed" | "open" {
    return this.isOpen() ? "open" : "closed";
  }
}

interface Connection {
  version: number;
  client: Client;
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown; cause?: { code?: unknown } } };
  for (const candidate of [e?.cause?.code, e?.cause?.cause?.code, e?.code]) if (typeof candidate === "string") return candidate;
  return undefined;
}

/**
 * Manages connections from the gateway to upstream MCP servers.
 *
 * Properties this guarantees:
 *  - Every request has a hard timeout; a hung upstream cannot hang a caller.
 *  - A failing upstream trips a per-server circuit breaker, so callers fail fast
 *    instead of queueing behind timeouts, and other servers are unaffected.
 *  - Connections are keyed by the server's config version, so editing a URL or
 *    credential takes effect on the next request.
 *  - Upstream credentials are attached here and only here. Nothing from the
 *    client's request is ever forwarded upstream.
 *  - Redirects are refused and every connection re-checks the address (SSRF).
 */
export class UpstreamPool {
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly agent: Agent;

  constructor(
    private readonly opts: PoolOptions,
    private readonly log: Logger,
  ) {
    this.agent = new Agent({
      connect: { lookup: createGuardedLookup(opts.ssrf) as never, timeout: opts.connectTimeoutMs },
      headersTimeout: opts.callTimeoutMs + 5000,
      bodyTimeout: opts.callTimeoutMs + 5000,
      keepAliveTimeout: 10_000,
    });
  }

  breakerState(serverId: string): "closed" | "open" {
    return this.breakers.get(serverId)?.state ?? "closed";
  }

  async listTools(server: ConnectableUpstream): Promise<Tool[]> {
    return this.run(server, this.opts.listTimeoutMs, async (client, timeout) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined, { timeout });
        tools.push(...res.tools);
        cursor = res.nextCursor;
        if (!cursor || tools.length >= 2000) break;
      }
      return tools;
    });
  }

  async callTool(server: ConnectableUpstream, name: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CallToolResult> {
    return this.run(server, this.opts.callTimeoutMs, async (client, timeout) => {
      const result = await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout, signal });
      return result as CallToolResult;
    });
  }

  /** Drops the cached connection (e.g. after the server was edited, disabled or removed). */
  async forget(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    this.connections.delete(serverId);
    this.breakers.delete(serverId);
    await conn?.client.close().catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((c) => c.client.close()));
    this.connections.clear();
    await this.agent.close().catch(() => {});
  }

  // ---- internals ------------------------------------------------------------

  private breakerFor(server: ConnectableUpstream): CircuitBreaker {
    let breaker = this.breakers.get(server.id);
    if (!breaker) {
      breaker = new CircuitBreaker(this.opts.breakerFailures, this.opts.breakerCooldownMs);
      this.breakers.set(server.id, breaker);
    }
    return breaker;
  }

  private async run<T>(server: ConnectableUpstream, timeoutMs: number, fn: (client: Client, timeoutMs: number) => Promise<T>): Promise<T> {
    // A config change (new version) gets a clean slate: new connection, closed breaker.
    const existing = this.connections.get(server.id);
    if (existing && existing.version !== server.version) await this.forget(server.id);

    const breaker = this.breakerFor(server);
    if (breaker.isOpen()) {
      throw new UpstreamError("circuit_open", `Upstream "${server.slug}" is unavailable (it failed repeatedly just now). Other servers are unaffected; retry shortly.`, false);
    }

    try {
      const conn = await this.connection(server);
      const result = await fn(conn.client, timeoutMs);
      breaker.onSuccess();
      return result;
    } catch (err) {
      const mapped = this.classify(err, server, timeoutMs);
      if (mapped.trips) {
        breaker.onFailure();
        // A broken connection is rebuilt on the next attempt (covers upstream restarts).
        await this.discard(server.id);
      }
      throw mapped;
    }
  }

  private connection(server: ConnectableUpstream): Promise<Connection> {
    const cached = this.connections.get(server.id);
    if (cached && cached.version === server.version) return Promise.resolve(cached);
    const inflight = this.connecting.get(server.id);
    if (inflight) return inflight;

    const attempt = this.connect(server)
      .then((conn) => {
        this.connections.set(server.id, conn);
        return conn;
      })
      .finally(() => this.connecting.delete(server.id));
    this.connecting.set(server.id, attempt);
    return attempt;
  }

  private async connect(server: ConnectableUpstream): Promise<Connection> {
    const headers: Record<string, string> = { "user-agent": "mcp-portal-gateway/1.0" };
    if (server.credential) {
      if (server.authType === "bearer") headers["authorization"] = `Bearer ${server.credential}`;
      else if (server.authType === "header" && server.authHeaderName) headers[server.authHeaderName] = server.credential;
    }

    const guardedFetch = ((url: string | URL, init?: RequestInit) =>
      undiciFetch(url as string, { ...(init as object), dispatcher: this.agent, redirect: "error" } as never)) as unknown as typeof fetch;

    const transport = new StreamableHTTPClientTransport(new URL(server.url), { fetch: guardedFetch, requestInit: { headers } });
    const client = new Client({ name: "mcp-portal-gateway", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: this.opts.connectTimeoutMs });
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    client.onerror = (err) => this.log.debug({ slug: server.slug, err: err.message }, "upstream client error");
    return { version: server.version, client };
  }

  private async discard(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    this.connections.delete(serverId);
    await conn?.client.close().catch(() => {});
  }

  /** Turns any thrown value into a stable, safe UpstreamError. Never includes credentials. */
  private classify(err: unknown, server: ConnectableUpstream, timeoutMs: number): UpstreamError {
    if (err instanceof UpstreamError) return err;
    const label = `"${server.slug}"`;
    const code = errorCode(err);
    const name = (err as { name?: string })?.name;

    if (code === "ESSRFBLOCKED") return new UpstreamError("blocked", `Upstream ${label} was blocked by the gateway's network policy.`, false);
    if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) return new UpstreamError("timeout", `Upstream ${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    if (name === "TimeoutError" || name === "AbortError") return new UpstreamError("timeout", `Upstream ${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    if (err instanceof StreamableHTTPError) {
      if (err.code === 401 || err.code === 403) return new UpstreamError("auth", `Upstream ${label} rejected the gateway's credential (HTTP ${err.code}). An admin must update it.`);
      if (err.code !== undefined && err.code >= 500) return new UpstreamError("unreachable", `Upstream ${label} is failing (HTTP ${err.code}).`);
      return new UpstreamError("protocol", `Upstream ${label} returned HTTP ${err.code ?? "error"}; it may not be a Streamable HTTP MCP server.`);
    }
    if (err instanceof McpError) {
      // A well-formed protocol error from a healthy server (bad arguments, unknown tool). Not an outage.
      return new UpstreamError("protocol", `Upstream ${label} reported an error: ${err.message.replace(/^MCP error -?\d+:\s*/, "").slice(0, 300)}`, false);
    }
    if (code && NETWORK_CODES.has(code)) {
      const reason = code === "ECONNREFUSED" ? "connection refused" : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "DNS lookup failed" : code.includes("TIMEOUT") ? "connection timed out" : "connection failed";
      return new UpstreamError("unreachable", `Upstream ${label} is unreachable (${reason}).`);
    }
    if ((err as Error)?.message?.includes("fetch failed")) return new UpstreamError("unreachable", `Upstream ${label} is unreachable.`);
    this.log.warn({ slug: server.slug, err: (err as Error)?.message }, "unclassified upstream error");
    return new UpstreamError("protocol", `Upstream ${label} failed unexpectedly.`);
  }
}
