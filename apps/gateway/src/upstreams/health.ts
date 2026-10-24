import type { Logger } from "pino";
import type { ToolCatalog } from "./catalog.js";
import type { HealthStatus, UpstreamRegistry } from "./registry.js";

export interface HealthResult {
  serverId: string;
  status: HealthStatus;
  reason: string | null;
  latencyMs: number | null;
  toolCount: number | null;
}

/**
 * Probes every enabled upstream on an interval and records the outcome.
 *
 * It does double duty: the probe is a tool-list refresh, so it also keeps the catalog
 * cache warm (client requests rarely pay for a cold refresh) and is what lets a stopped
 * circuit breaker recover without waiting for user traffic.
 *
 * Every replica runs its own monitor. Writes are idempotent last-write-wins updates of
 * the same row, so no leader election is needed.
 */
export class HealthMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly registry: UpstreamRegistry,
    private readonly catalog: ToolCatalog,
    private readonly intervalMs: number,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkAll(): Promise<HealthResult[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const servers = await this.registry.listConnectable({ onlyEnabled: true });
      return await Promise.all(servers.map((s) => this.check(s.id)));
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "health sweep failed");
      return [];
    } finally {
      this.running = false;
    }
  }

  /** Probes one server now and persists the result. */
  async check(serverId: string): Promise<HealthResult> {
    const server = await this.registry.getConnectable(serverId);
    if (!server) return { serverId, status: "unknown", reason: "Server not found", latencyMs: null, toolCount: null };
    if (!server.enabled) return { serverId, status: "unknown", reason: "Disabled", latencyMs: null, toolCount: null };

    const started = Date.now();
    const snap = await this.catalog.refresh(server, true);
    const latencyMs = Date.now() - started;

    const result: HealthResult = snap.ok
      ? { serverId, status: "connected", reason: null, latencyMs, toolCount: snap.entries.length }
      : { serverId, status: "unreachable", reason: snap.error?.message ?? "Unreachable", latencyMs: null, toolCount: snap.entries.length || null };

    await this.registry.recordHealth(serverId, result).catch((err) => this.log.error({ err: (err as Error).message }, "failed to record health"));
    return result;
  }
}
