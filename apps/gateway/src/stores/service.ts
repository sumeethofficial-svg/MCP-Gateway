import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { Principal } from "../auth/principal.js";
import type { AuditService } from "../audit/audit.js";
import { AppError, badRequest, notFound, tooMany } from "../errors.js";
import type { ToolCatalog } from "../upstreams/catalog.js";
import type { HealthMonitor } from "../upstreams/health.js";
import type { UpstreamPool } from "../upstreams/pool.js";
import type { UpstreamRecord, UpstreamRegistry } from "../upstreams/registry.js";
import { UrlRejectedError, validateUpstreamUrl, type SsrfPolicy } from "../upstreams/ssrf.js";
import { RateLimiter } from "../util/rate-limiter.js";
import { ProvisionerError, type ProvisionerClient, type StoreInfo } from "./client.js";

/** What a user sees about a store: the provisioner's facts, plus how it is wired into the gateway. */
export interface StoreSummary extends StoreInfo {
  owned: boolean;
  /** Prefix of this store's tool names, e.g. "woo-berlin__". Empty until the store is registered. */
  toolPrefix: string | null;
  registered: boolean;
  serverStatus: string | null;
  toolCount: number | null;
}

type Resolver = Parameters<typeof validateUpstreamUrl>[2];

export interface StoreServiceDeps {
  client: ProvisionerClient;
  registry: UpstreamRegistry;
  pool: UpstreamPool;
  catalog: ToolCatalog;
  health: HealthMonitor;
  audit: AuditService;
  ssrf: SsrfPolicy;
  log: Logger;
  resolver?: Resolver;
}

/** The gateway slug of a store's server. "woo-" + the id keeps the tool names self-explanatory: woo-berlin__list_products. */
export const slugForStore = (storeId: string): string => `woo-${storeId}`;

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 11)
    .replace(/-+$/g, "");

/** Maps a provisioner failure to something the dashboard can show. */
function toAppError(err: unknown): unknown {
  if (!(err instanceof ProvisionerError)) return err;
  if ([400, 404, 409].includes(err.status)) return new AppError(err.status, err.code, err.message);
  return new AppError(503, "stores_unavailable", "Store management is temporarily unavailable. Try again in a moment.");
}

/**
 * Connects the provisioner (which builds stores) to the gateway (which serves their tools).
 *
 * The provisioner is the source of truth. A sync loop makes the gateway's `upstream_servers` rows match it:
 * a store that becomes Ready gets its own server `woo-<id>` (own credential, owned by the store's creator); a store that
 * is deleted, failed or gone loses it. If the provisioner cannot be reached the loop changes nothing, so a provisioner
 * restart never makes stores' tools disappear.
 */
export class StoreService {
  private readonly createLimiter = new RateLimiter(10, 10 * 60_000);
  private running?: Promise<void>;
  private again = false;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly d: StoreServiceDeps,
    private readonly intervalMs: number,
  ) {}

  // -------------------------------------------------------------- user-facing

  async list(principal: Principal): Promise<StoreSummary[]> {
    const isAdmin = principal.role === "admin";
    let stores: StoreInfo[];
    try {
      stores = await this.d.client.list();
    } catch (err) {
      throw toAppError(err);
    }
    const servers = new Map((await this.d.registry.listStoreServers()).map((s) => [s.storeId, s]));
    return stores
      .filter((s) => isAdmin || s.ownerId === principal.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => this.summarise(s, principal, servers.get(s.id)));
  }

  async get(principal: Principal, id: string): Promise<StoreSummary> {
    const store = await this.visible(principal, id);
    return this.summarise(store, principal, (await this.d.registry.listStoreServers()).find((s) => s.storeId === id));
  }

  /**
   * Safe to retry: the id decides identity. A client that sends the same id again (after a timeout, a double click, a
   * page reload) gets the same store back instead of a second one. Without an id, one is derived from the name.
   */
  async create(principal: Principal, input: { name: string; id?: string }): Promise<{ store: StoreSummary; created: boolean }> {
    const name = input.name.trim();
    if (!name || name.length > 60) throw badRequest("Store name is required (max 60 characters)", "invalid_name");
    const id = input.id ?? `${slugify(name) || "store"}-${randomBytes(3).toString("hex")}`;

    const limit = this.createLimiter.consume(principal.userId);
    if (!limit.allowed) throw tooMany("You are creating stores too quickly. Wait a moment and try again.", limit.retryAfterMs);

    const started = Date.now();
    try {
      const { store, created } = await this.d.client.create({ id, name, ownerId: principal.userId, ownerEmail: principal.email });
      await this.audit(principal, "create_store", { id, name }, "ok", started);
      void this.sync();
      return { store: this.summarise(store, principal, undefined), created };
    } catch (err) {
      await this.audit(principal, "create_store", { id, name }, "error", started, (err as Error).message);
      throw toAppError(err);
    }
  }

  async remove(principal: Principal, id: string): Promise<StoreSummary> {
    const store = await this.visible(principal, id);
    const started = Date.now();
    try {
      const deleting = await this.d.client.remove(id);
      // Withdraw the tools immediately; the sync would do it within seconds, but a store being deleted should stop answering now.
      const server = (await this.d.registry.listStoreServers()).find((s) => s.storeId === id);
      if (server) await this.unregister(server);
      await this.audit(principal, "delete_store", { id, name: store.name }, "ok", started);
      void this.sync();
      return this.summarise(deleting, principal, undefined);
    } catch (err) {
      await this.audit(principal, "delete_store", { id }, "error", started, (err as Error).message);
      throw toAppError(err);
    }
  }

  /** The store, if this user may see it. Someone else's store looks exactly like one that does not exist. */
  private async visible(principal: Principal, id: string): Promise<StoreInfo> {
    let store: StoreInfo | undefined;
    try {
      store = await this.d.client.get(id);
    } catch (err) {
      throw toAppError(err);
    }
    if (!store || (principal.role !== "admin" && store.ownerId !== principal.userId)) throw notFound("Store not found", "not_found");
    return store;
  }

  private summarise(s: StoreInfo, principal: Principal, server: UpstreamRecord | undefined): StoreSummary {
    return {
      ...s,
      owned: s.ownerId === principal.userId,
      toolPrefix: server ? `${server.slug}__` : null,
      registered: !!server,
      serverStatus: server ? (server.enabled ? server.status : "disabled") : null,
      toolCount: server?.toolCount ?? null,
    };
  }

  private async audit(principal: Principal, tool: string, args: unknown, outcome: "ok" | "error", started: number, message?: string): Promise<void> {
    await this.d.audit
      .record({ principal, serverSlug: "stores", toolName: tool, exposedName: `stores__${tool}`, outcome, errorMessage: message, durationMs: Date.now() - started, args })
      .catch((err) => this.d.log.warn({ err: (err as Error).message }, "could not write the store audit entry"));
  }

  // --------------------------------------------------------------------- sync

  start(): void {
    if (this.timer || this.stopped) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reconciles now. Calls during a run coalesce into one more run, so a burst never piles up. */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    let stores: StoreInfo[];
    try {
      stores = await this.d.client.list();
    } catch (err) {
      this.d.log.warn({ err: (err as Error).message }, "store sync skipped: the provisioner is not reachable; registrations left as they are");
      return;
    }
    const live = new Map(stores.map((s) => [s.id, s]));
    try {
      for (const store of stores) if (store.phase === "Ready") await this.ensureRegistered(store);
      for (const server of await this.d.registry.listStoreServers()) {
        const store = server.storeId ? live.get(server.storeId) : undefined;
        if (!store || store.phase !== "Ready") await this.unregister(server);
      }
    } catch (err) {
      this.d.log.error({ err: (err as Error).message }, "store sync failed; will retry");
    }
  }

  private async ensureRegistered(store: StoreInfo): Promise<void> {
    const slug = slugForStore(store.id);
    try {
      const existing = await this.d.registry.getStoreServer(store.id);
      const clash = await this.d.registry.getBySlug(slug);
      if (clash && clash.storeId !== store.id) {
        this.d.log.warn({ store: store.id, slug }, "cannot register the store: an unrelated server already uses its slug");
        return;
      }
      const endpoint = await this.d.client.mcpEndpoint(store.id);
      // The address comes from our own provisioner, but it is checked like any admin-supplied URL: if the provisioner were
      // ever tricked into returning something else, the gateway still refuses to connect to it.
      await validateUpstreamUrl(endpoint.url, this.d.ssrf, this.d.resolver);

      if (!existing) {
        const created = await this.d.registry.create(
          { slug, name: store.name, url: endpoint.url, authType: "bearer", credential: endpoint.token, trustAnnotations: true },
          "provisioner",
          { ownerId: store.ownerId || null, storeId: store.id },
        );
        this.d.log.info({ store: store.id, slug }, "registered store server");
        await this.d.health.check(created.id);
        return;
      }
      if (existing.url !== endpoint.url || existing.name !== store.name || existing.credential !== endpoint.token) {
        await this.d.registry.update(existing.id, { name: store.name, url: endpoint.url, authType: "bearer", credential: endpoint.token });
        await this.d.pool.forget(existing.id);
        this.d.catalog.invalidate(existing.id);
        if (existing.enabled) await this.d.health.check(existing.id);
        this.d.log.info({ store: store.id, slug }, "updated store server");
      }
    } catch (err) {
      const reason = err instanceof UrlRejectedError ? `address refused: ${err.message}` : (err as Error).message;
      this.d.log.warn({ store: store.id, reason }, "could not register store server; will retry");
    }
  }

  private async unregister(server: UpstreamRecord): Promise<void> {
    await this.d.registry.removeStoreServer(server.id);
    await this.d.pool.forget(server.id);
    this.d.catalog.invalidate(server.id);
    this.d.log.info({ slug: server.slug }, "removed store server");
  }
}
