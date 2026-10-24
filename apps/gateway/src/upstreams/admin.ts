import { randomUUID } from "node:crypto";
import { badRequest, conflict, notFound } from "../errors.js";
import type { ToolCatalog } from "./catalog.js";
import type { HealthMonitor } from "./health.js";
import type { UpstreamPool } from "./pool.js";
import { UpstreamError } from "./pool.js";
import type { AuthType, ConnectableUpstream, UpstreamInput, UpstreamPatch, UpstreamRecord, UpstreamRegistry } from "./registry.js";
import { describeFindings, scanTool } from "./scanner.js";
import { UrlRejectedError, validateUpstreamUrl, type SsrfPolicy } from "./ssrf.js";

type Resolver = Parameters<typeof validateUpstreamUrl>[2];

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  tools?: { name: string; description: string; flagged: boolean; findings: string }[];
}

/**
 * Every server mutation goes through here, so URL safety, cache invalidation and the
 * follow-up health probe cannot be forgotten by a caller.
 */
export class UpstreamAdmin {
  constructor(
    private readonly registry: UpstreamRegistry,
    private readonly catalog: ToolCatalog,
    private readonly pool: UpstreamPool,
    private readonly health: HealthMonitor,
    private readonly ssrf: SsrfPolicy,
    private readonly resolver?: Resolver,
  ) {}

  private async checkUrl(url: string): Promise<void> {
    try {
      await validateUpstreamUrl(url, this.ssrf, this.resolver);
    } catch (err) {
      if (err instanceof UrlRejectedError) throw badRequest(err.message, "url_rejected");
      throw err;
    }
  }

  async create(input: UpstreamInput): Promise<UpstreamRecord> {
    await this.checkUrl(input.url);
    const created = await this.registry.create(input);
    await this.health.check(created.id);
    return (await this.registry.get(created.id)) ?? created;
  }

  async update(id: string, patch: UpstreamPatch): Promise<UpstreamRecord> {
    const current = await this.registry.get(id);
    if (!current) throw notFound("Server not found");
    if (current.managedBy !== "admin") {
      const forbidden = Object.keys(patch).filter((k) => k !== "enabled");
      if (forbidden.length > 0) {
        throw conflict(
          current.managedBy === "helm"
            ? "This server is managed by Helm values. You can enable or disable it here; change anything else in values and upgrade the release."
            : "This server belongs to a store and is managed automatically. You can enable or disable it here.",
          "managed_server",
        );
      }
    }
    if (patch.url !== undefined && patch.url !== current.url) await this.checkUrl(patch.url);
    const updated = await this.registry.update(id, patch);
    await this.pool.forget(id);
    this.catalog.invalidate(id);
    if (updated.enabled) await this.health.check(id);
    return (await this.registry.get(id)) ?? updated;
  }

  async setEnabled(id: string, enabled: boolean): Promise<UpstreamRecord> {
    const updated = await this.registry.setEnabled(id, enabled);
    await this.pool.forget(id);
    this.catalog.invalidate(id);
    if (enabled) await this.health.check(id);
    return (await this.registry.get(id)) ?? updated;
  }

  async remove(id: string): Promise<void> {
    await this.registry.remove(id);
    await this.pool.forget(id);
    this.catalog.invalidate(id);
  }

  /** Connects with the supplied settings and lists tools, without saving anything. */
  async test(input: { url: string; authType: AuthType; authHeaderName?: string | null; credential?: string | null }): Promise<TestResult> {
    await this.checkUrl(input.url);
    const probe: ConnectableUpstream = {
      id: `test-${randomUUID()}`,
      slug: "test",
      name: "test",
      url: input.url,
      authType: input.authType,
      authHeaderName: input.authHeaderName ?? null,
      hasCredential: !!input.credential,
      credential: input.credential ?? null,
      enabled: true,
      trustAnnotations: false,
      managedBy: "admin",
      ownerId: null,
      storeId: null,
      version: 1,
      status: "unknown",
      statusReason: null,
      lastCheckedAt: null,
      lastLatencyMs: null,
      toolCount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const started = Date.now();
    try {
      const tools = await this.pool.listTools(probe);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        tools: tools.map((t) => {
          const findings = scanTool(t);
          return { name: t.name, description: (t.description ?? "").slice(0, 200), flagged: findings.length > 0, findings: describeFindings(findings) };
        }),
      };
    } catch (err) {
      return { ok: false, error: err instanceof UpstreamError ? err.message : "Connection failed" };
    } finally {
      await this.pool.forget(probe.id);
    }
  }
}
