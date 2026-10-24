import { randomUUID } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import type { Principal } from "../auth/principal.js";
import { AuditService, type Outcome } from "../audit/audit.js";
import type { Metrics } from "../metrics.js";
import { decide, PolicyStore } from "../policy/engine.js";
import type { RateLimiter } from "../util/rate-limiter.js";
import type { CatalogEntry, ServerSnapshot, ToolCatalog } from "../upstreams/catalog.js";
import { UpstreamError, type UpstreamPool } from "../upstreams/pool.js";
import type { UpstreamRegistry } from "../upstreams/registry.js";

export interface CallContext {
  requestId?: string;
  clientName?: string;
  signal?: AbortSignal;
}

export interface GatewayServiceOptions {
  maxResultBytes: number;
}

/** Thrown for a call to a tool name the gateway does not know. Maps to a JSON-RPC invalid-params error. */
export class UnknownToolError extends Error {}

const TEXT = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** `<slug>__<tool>` -> slug. The slug alphabet excludes underscores, so the first `__` is unambiguous. */
function slugOf(exposedName: string): string | undefined {
  const idx = exposedName.indexOf("__");
  return idx > 0 ? exposedName.slice(0, idx) : undefined;
}

/**
 * The business logic of the gateway, independent of transport. The external MCP endpoint
 * and the in-dashboard chat agent both call into this class, which is what guarantees they
 * share one permission model and one audit trail.
 */
export class GatewayService {
  constructor(
    private readonly registry: UpstreamRegistry,
    private readonly catalog: ToolCatalog,
    private readonly pool: UpstreamPool,
    private readonly policy: PolicyStore,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly metrics: Metrics,
    private readonly opts: GatewayServiceOptions,
    private readonly log: Logger,
  ) {}

  /** Tools this principal may see: approved, from reachable enabled servers, and permitted. */
  async listVisibleTools(principal: Principal): Promise<{ tools: Tool[]; entries: CatalogEntry[]; unreachable: { server: string; message: string }[] }> {
    const [snapshots, rules] = await Promise.all([this.catalog.snapshot(), this.policy.rulesFor(principal)]);
    const entries: CatalogEntry[] = [];
    const unreachable: { server: string; message: string }[] = [];

    for (const snap of snapshots) {
      if (!snap.ok && snap.entries.length === 0) unreachable.push({ server: snap.server.slug, message: snap.error?.message ?? "unreachable" });
      for (const entry of snap.entries) {
        if (entry.pin.status !== "approved") continue;
        if (!decide(principal, entry, rules).allowed) continue;
        entries.push(entry);
      }
    }
    entries.sort((a, b) => a.exposedName.localeCompare(b.exposedName));
    return { tools: entries.map(toMcpTool), entries, unreachable };
  }

  /** Ranked keyword search over the tools this principal may see. Powers the lazy-loading mode. */
  async searchTools(principal: Principal, query: string, limit = 10): Promise<{ name: string; server: string; description: string; readOnly: boolean }[]> {
    const { entries } = await this.listVisibleTools(principal);
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    const scored = entries
      .map((e) => {
        const name = e.exposedName.toLowerCase();
        const title = (e.title ?? "").toLowerCase();
        const desc = e.description.toLowerCase();
        const score = terms.reduce((sum, t) => sum + (name.includes(t) ? 3 : 0) + (title.includes(t) ? 2 : 0) + (desc.includes(t) ? 1 : 0), 0);
        return { e, score };
      })
      .filter((s) => terms.length === 0 || s.score > 0)
      .sort((a, b) => b.score - a.score || a.e.exposedName.localeCompare(b.e.exposedName))
      .slice(0, Math.min(Math.max(limit, 1), 20));
    return scored.map(({ e }) => ({
      name: e.exposedName,
      server: e.server.slug,
      description: e.description.slice(0, 200),
      readOnly: e.server.trustAnnotations && e.annotations?.readOnlyHint === true,
    }));
  }

  async describeTool(principal: Principal, exposedName: string): Promise<Tool | undefined> {
    const { tools } = await this.listVisibleTools(principal);
    return tools.find((t) => t.name === exposedName);
  }

  /**
   * Routes one tool call. Never throws for operational failures: those come back as an
   * `isError` result so the model can read the reason. Exactly one audit row is written.
   */
  async callTool(principal: Principal, exposedName: string, args: Record<string, unknown> | undefined, ctx: CallContext = {}): Promise<CallToolResult> {
    const started = performance.now();
    const requestId = ctx.requestId ?? randomUUID();
    let serverSlug = slugOf(exposedName);
    let toolName: string | undefined;
    let outcome: Outcome = "error";
    let errorMessage: string | undefined;

    try {
      const limit = this.limiter.consume(principal.userId);
      if (!limit.allowed) {
        outcome = "rate_limited";
        errorMessage = `Rate limit exceeded. Retry in ${Math.ceil(limit.retryAfterMs / 1000)}s.`;
        return TEXT(errorMessage);
      }

      // Resolve only the target server. A dead sibling must never delay this call.
      const snap = serverSlug ? await this.snapshotFor(serverSlug) : undefined;
      const entry = snap ? this.catalog.find([snap], exposedName) : undefined;
      if (!snap || !entry) {
        outcome = "not_found";
        errorMessage = `Unknown tool "${exposedName}"`;
        if (snap && !snap.ok) {
          // The server exists but we cannot see its tools: report the outage, not "unknown tool".
          outcome = "unavailable";
          errorMessage = snap.error?.message ?? `Upstream "${serverSlug}" is unavailable.`;
          return TEXT(errorMessage);
        }
        throw new UnknownToolError(errorMessage);
      }
      serverSlug = entry.server.slug;
      toolName = entry.upstreamName;

      if (entry.pin.status !== "approved") {
        outcome = "quarantined";
        errorMessage = `"${exposedName}" is awaiting administrator review and cannot be called yet.`;
        return TEXT(errorMessage);
      }

      const decision = decide(principal, entry, await this.policy.rulesFor(principal));
      if (!decision.allowed) {
        outcome = "denied";
        errorMessage = `Not permitted: ${decision.reason}.`;
        return TEXT(errorMessage);
      }

      try {
        const result = await this.pool.callTool(snap.server, entry.upstreamName, args, ctx.signal);
        outcome = result.isError ? "tool_error" : "ok";
        if (result.isError) errorMessage = firstText(result)?.slice(0, 500);
        return this.limitSize(result, exposedName);
      } catch (err) {
        const failure = err instanceof UpstreamError ? err : new UpstreamError("protocol", `Upstream "${serverSlug}" failed unexpectedly.`);
        if (!(err instanceof UpstreamError)) this.log.error({ err: (err as Error).message, exposedName }, "unexpected call failure");
        outcome = failure.kind === "timeout" ? "timeout" : failure.kind === "unreachable" || failure.kind === "circuit_open" ? "unavailable" : "error";
        errorMessage = failure.message;
        return TEXT(failure.message);
      }
    } finally {
      const durationMs = performance.now() - started;
      this.metrics.toolCalls.inc({ server: serverSlug ?? "unknown", tool: toolName ?? "unknown", outcome, via: principal.via });
      this.metrics.toolDuration.observe({ server: serverSlug ?? "unknown", outcome }, durationMs / 1000);
      await this.audit
        .record({ requestId, principal, clientName: ctx.clientName, serverSlug, toolName, exposedName, outcome, errorMessage, durationMs, args })
        .catch((err) => this.log.error({ err: (err as Error).message }, "FAILED TO WRITE AUDIT RECORD"));
    }
  }

  private async snapshotFor(slug: string): Promise<ServerSnapshot | undefined> {
    const servers = await this.registry.listConnectable({ onlyEnabled: true });
    const server = servers.find((s) => s.slug === slug);
    return server ? this.catalog.refresh(server) : undefined;
  }

  /** Caps what a single upstream result can inject into a model's context window. */
  private limitSize(result: CallToolResult, name: string): CallToolResult {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size <= this.opts.maxResultBytes) return result;
    this.log.warn({ name, size }, "tool result truncated");
    return {
      isError: result.isError,
      content: [{ type: "text", text: `[Result from ${name} was ${size} bytes, over the gateway limit of ${this.opts.maxResultBytes}, and was withheld. Ask for a smaller page or a narrower query.]` }],
    };
  }
}

function firstText(result: CallToolResult): string | undefined {
  const block = result.content?.find((c): c is { type: "text"; text: string } => c.type === "text");
  return block?.text;
}

/** The tool as presented to MCP clients. */
export function toMcpTool(entry: CatalogEntry): Tool {
  const annotations = entry.annotations ? { ...entry.annotations } : undefined;
  // Clients such as Claude Code skip confirmation for tools that claim to be read-only. Only
  // pass that claim on when an admin has chosen to trust this server.
  if (annotations && !entry.server.trustAnnotations) delete annotations.readOnlyHint;
  return {
    name: entry.exposedName,
    ...(entry.title ? { title: entry.title } : {}),
    description: entry.description,
    inputSchema: entry.inputSchema,
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  };
}
