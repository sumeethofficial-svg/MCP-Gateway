import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { sha256Hex } from "../crypto.js";
import type { Metrics } from "../metrics.js";
import { UpstreamError, type UpstreamPool } from "./pool.js";
import { PinStore, type PinRecord, type PinStatus } from "./pins.js";
import type { ConnectableUpstream, UpstreamRegistry } from "./registry.js";
import { sanitizeText } from "./scanner.js";

const MAX_TOOL_NAME = 64; // the practical limit enforced by common MCP clients and LLM APIs
const MAX_DESCRIPTION = 2000;

export interface CatalogEntry {
  server: { id: string; slug: string; name: string; trustAnnotations: boolean; ownerId?: string | null };
  /** The name as the upstream knows it. Used when routing the call. */
  upstreamName: string;
  /** `<server-slug>__<tool>`: unique across servers, safe for clients and LLM APIs. */
  exposedName: string;
  title?: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  outputSchema?: Tool["outputSchema"];
  annotations?: ToolAnnotations;
  pin: { status: PinStatus; flags: string[]; reason: string | null; defHash: string };
}

export interface ServerSnapshot {
  server: ConnectableUpstream;
  ok: boolean;
  /** True when serving a cached copy because the live refresh failed. */
  stale: boolean;
  error?: { kind: string; message: string };
  latencyMs?: number;
  fetchedAt: number;
  entries: CatalogEntry[];
}

interface CacheEntry {
  version: number;
  fetchedAt: number;
  entries: CatalogEntry[];
  latencyMs: number;
}

/** Unique, client-safe name for a tool. Deterministic, so names stay stable across restarts. */
export function exposedNameFor(slug: string, toolName: string, taken: Set<string>): string {
  const safe = toolName.replace(/[^A-Za-z0-9_.-]/g, "_");
  let candidate = `${slug}__${safe}`;
  if (candidate.length > MAX_TOOL_NAME) candidate = `${candidate.slice(0, MAX_TOOL_NAME - 7)}_${sha256Hex(toolName).slice(0, 6)}`;
  const base = candidate;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base.slice(0, MAX_TOOL_NAME - 3)}_${n}`;
  taken.add(candidate);
  return candidate;
}

export interface CatalogOptions {
  ttlMs: number;
  /** How long a cached tool list may be served after the upstream stops answering. */
  staleGraceMs: number;
}

/**
 * Aggregates tool lists from all enabled upstream servers.
 *
 * Failure isolation is the design goal: every server is refreshed concurrently, each
 * bounded by its own timeout and circuit breaker, so a slow or dead upstream costs the
 * caller at most that one timeout and never affects the other servers' tools.
 */
export class ToolCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ServerSnapshot>>();

  constructor(
    private readonly registry: UpstreamRegistry,
    private readonly pool: UpstreamPool,
    private readonly pins: PinStore,
    private readonly opts: CatalogOptions,
    private readonly metrics: Metrics,
    private readonly log: Logger,
  ) {}

  /** Snapshot of every enabled server. Never throws; per-server failures are reported in the result. */
  async snapshot(opts: { force?: boolean } = {}): Promise<ServerSnapshot[]> {
    const servers = await this.registry.listConnectable({ onlyEnabled: true });
    this.evictMissing(new Set(servers.map((s) => s.id)));
    return Promise.all(servers.map((s) => this.refresh(s, opts.force ?? false)));
  }

  /** Finds a tool by its exposed name in a snapshot. */
  find(snapshots: ServerSnapshot[], exposedName: string): CatalogEntry | undefined {
    for (const snap of snapshots) for (const entry of snap.entries) if (entry.exposedName === exposedName) return entry;
    return undefined;
  }

  /** Looks up a single server's current state, refreshing if the cache is cold or stale. */
  async refresh(server: ConnectableUpstream, force = false): Promise<ServerSnapshot> {
    const cached = this.cache.get(server.id);
    const fresh = cached && cached.version === server.version && Date.now() - cached.fetchedAt < this.opts.ttlMs;
    if (!force && fresh) return this.fromCache(server, cached, false);

    // Coalesce concurrent refreshes (a burst of tools/list calls triggers one upstream request).
    const key = `${server.id}:${server.version}:${force}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.load(server).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }

  private evictMissing(liveIds: Set<string>): void {
    for (const id of this.cache.keys()) {
      if (!liveIds.has(id)) {
        this.cache.delete(id);
        void this.pool.forget(id);
      }
    }
  }

  private fromCache(server: ConnectableUpstream, cached: CacheEntry, stale: boolean, error?: UpstreamError): ServerSnapshot {
    return {
      server,
      ok: !stale,
      stale,
      error: error ? { kind: error.kind, message: error.message } : undefined,
      latencyMs: cached.latencyMs,
      fetchedAt: cached.fetchedAt,
      entries: cached.entries,
    };
  }

  private async load(server: ConnectableUpstream): Promise<ServerSnapshot> {
    const started = Date.now();
    try {
      const tools = await this.pool.listTools(server);
      const pins = await this.pins.sync(server.id, tools, server.managedBy !== "admin");
      const entries = this.buildEntries(server, tools, pins);
      const cached: CacheEntry = { version: server.version, fetchedAt: Date.now(), entries, latencyMs: Date.now() - started };
      this.cache.set(server.id, cached);
      this.metrics.upstreamUp.set({ server: server.slug }, 1);
      return this.fromCache(server, cached, false);
    } catch (err) {
      const failure = err instanceof UpstreamError ? err : new UpstreamError("protocol", `Upstream "${server.slug}" failed unexpectedly.`);
      if (!(err instanceof UpstreamError)) this.log.error({ slug: server.slug, err: (err as Error).message }, "catalog refresh failed");
      this.metrics.upstreamUp.set({ server: server.slug }, 0);

      // Stale-if-error: keep serving the last good list for a grace period, so a brief blip
      // does not make a server's tools flicker out of clients' tool lists.
      const cached = this.cache.get(server.id);
      if (cached && cached.version === server.version && Date.now() - cached.fetchedAt < this.opts.staleGraceMs) {
        return this.fromCache(server, cached, true, failure);
      }
      this.cache.delete(server.id);
      return { server, ok: false, stale: false, error: { kind: failure.kind, message: failure.message }, fetchedAt: Date.now(), entries: [] };
    }
  }

  private buildEntries(server: ConnectableUpstream, tools: Tool[], pins: Map<string, PinRecord>): CatalogEntry[] {
    const taken = new Set<string>();
    return tools.map((tool) => {
      const pin = pins.get(tool.name);
      return {
        server: { id: server.id, slug: server.slug, name: server.name, trustAnnotations: server.trustAnnotations, ownerId: server.ownerId },
        upstreamName: tool.name,
        exposedName: exposedNameFor(server.slug, tool.name, taken),
        title: tool.title ? sanitizeText(tool.title, 120) : undefined,
        description: sanitizeText(tool.description, MAX_DESCRIPTION),
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        // Defence in depth: a tool with no pin record is never exposed.
        pin: pin ? { status: pin.status, flags: pin.flags, reason: pin.reason, defHash: pin.defHash } : { status: "quarantined", flags: [], reason: "Not yet reviewed", defHash: "" },
      };
    });
  }
}
