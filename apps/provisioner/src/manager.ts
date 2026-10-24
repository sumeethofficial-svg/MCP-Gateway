import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Helm } from "./helm.js";
import { KubeError, type Kube } from "./kube.js";
import {
  ANN_CREATED, ANN_NAME, ANN_OWNER_EMAIL, ANN_PHASE, ANN_READY, ANN_REASON,
  LABEL_MANAGED_BY, LABEL_OWNER, LABEL_STORE, LABEL_STORE_ID, MANAGER, toView, validateStoreId,
  type NamespaceObject, type StoreView,
} from "./model.js";

/** One Helm release per store, always under this name, so "which release is this?" is never a question. */
export const RELEASE = "store";
const OWNER_ID = /^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/;

/** An error whose message is safe to show to the caller. */
export class StoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface CreateInput {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail?: string;
}

interface Inflight {
  kind: "install" | "delete";
  controller: AbortController;
  /** Set when the abort is deliberate (timeout, deletion, shutdown) so the failure is not reported as an error. */
  quiet: boolean;
  promise: Promise<void>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 280);

/**
 * Owns the lifecycle of stores. It keeps no database: a store is a Namespace, and its phase, owner and reason are
 * labels and annotations on it. A restart therefore loses nothing, and `reconcile()` is the only place that moves a
 * store forward, which is what makes creation safe to retry and interruptions safe to recover from.
 */
export class StoreManager {
  private readonly inflight = new Map<string, Inflight>();
  private chain: Promise<unknown> = Promise.resolve();
  private running?: Promise<void>;
  private rerun = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private baseValuesFile?: string;

  constructor(
    private readonly kube: Kube,
    private readonly helm: Helm,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private ns(id: string): string {
    return `${this.config.nsPrefix}${id}`;
  }

  private view(ns: NamespaceObject): StoreView | undefined {
    return toView(ns, this.config.scheme, this.config.baseDomain);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------------ reads

  async list(ownerId?: string): Promise<StoreView[]> {
    const all = (await this.kube.listStoreNamespaces()).map((n) => this.view(n)).filter((v): v is StoreView => v !== undefined);
    return all.filter((v) => ownerId === undefined || v.ownerId === ownerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<StoreView | undefined> {
    if (validateStoreId(id)) return undefined;
    const ns = await this.kube.getNamespace(this.ns(id));
    return ns ? this.view(ns) : undefined;
  }

  /** Where the gateway reaches this store's MCP server, and the token it must present. Only for Ready stores. */
  async mcpEndpoint(id: string): Promise<{ url: string; token: string }> {
    const view = await this.get(id);
    if (!view) throw new StoreError(404, "not_found", "Store not found");
    if (view.phase !== "Ready") throw new StoreError(409, "not_ready", `The store is ${view.phase.toLowerCase()}`);
    const token = await this.kube.readSecretKey(view.namespace, "woo-mcp-auth", "token");
    if (!token) throw new StoreError(409, "not_ready", "The store's MCP credentials do not exist yet");
    return { url: `http://woo-mcp.${view.namespace}.svc.cluster.local:8080/mcp`, token };
  }

  // ----------------------------------------------------------------- create

  /** Idempotent: asking again for the same id and owner returns the existing store instead of creating another. */
  async create(input: CreateInput): Promise<{ store: StoreView; created: boolean }> {
    const bad = validateStoreId(input.id);
    if (bad) throw new StoreError(400, "invalid_id", bad);
    const name = input.name.trim();
    if (!name || name.length > 60) throw new StoreError(400, "invalid_name", "Store name is required (max 60 characters)");
    if (!OWNER_ID.test(input.ownerId)) throw new StoreError(400, "invalid_owner", "Invalid owner id");

    return this.serial(async () => {
      const ns = this.ns(input.id);
      const settle = (existing: NamespaceObject) => {
        const view = this.view(existing);
        if (!view || view.ownerId !== input.ownerId) throw new StoreError(409, "id_taken", "That store id is already in use");
        if (view.phase === "Deleting") throw new StoreError(409, "being_deleted", "That store is being deleted. Wait for it to finish, then create it again");
        return { store: view, created: false };
      };

      const existing = await this.kube.getNamespace(ns);
      if (existing) return settle(existing);

      const active = (await this.list()).filter((s) => s.phase !== "Deleting");
      if (active.length >= this.config.maxTotal) {
        throw new StoreError(409, "store_limit_total", `This platform is limited to ${this.config.maxTotal} stores. Delete one first`);
      }
      if (active.filter((s) => s.ownerId === input.ownerId).length >= this.config.maxPerUser) {
        throw new StoreError(409, "store_limit", `You can have at most ${this.config.maxPerUser} stores. Delete one first`);
      }

      const created = new Date(this.now()).toISOString();
      let made: NamespaceObject;
      try {
        made = await this.kube.createNamespace(
          ns,
          {
            [LABEL_STORE]: "true",
            [LABEL_STORE_ID]: input.id,
            [LABEL_OWNER]: input.ownerId,
            [LABEL_MANAGED_BY]: MANAGER,
            // WordPress needs the baseline profile (see the platform chart); the quota and policies come from the store chart.
            "pod-security.kubernetes.io/enforce": "baseline",
            "pod-security.kubernetes.io/warn": "baseline",
          },
          { [ANN_NAME]: name, [ANN_PHASE]: "Provisioning", [ANN_CREATED]: created, ...(input.ownerEmail ? { [ANN_OWNER_EMAIL]: input.ownerEmail } : {}) },
        );
      } catch (err) {
        if (err instanceof KubeError && err.status === 409) {
          const raced = await this.kube.getNamespace(ns);
          if (raced) return settle(raced);
        }
        throw err;
      }
      const store = this.view(made);
      if (!store) throw new StoreError(500, "internal", "Could not read back the new store");
      this.log.info({ store: input.id, owner: input.ownerId }, "store requested");
      void this.reconcile();
      return { store, created: true };
    });
  }

  // ----------------------------------------------------------------- delete

  /** Marks the store Deleting and returns at once; `reconcile()` does the teardown and retries until it is gone. */
  async remove(id: string): Promise<StoreView> {
    const view = await this.get(id);
    if (!view) throw new StoreError(404, "not_found", "Store not found");
    if (view.phase === "Deleting") return view;
    const running = this.inflight.get(id);
    if (running) {
      running.quiet = true;
      running.controller.abort();
    }
    await this.kube.annotateNamespace(view.namespace, { [ANN_PHASE]: "Deleting", [ANN_REASON]: null });
    this.log.info({ store: id }, "store deletion requested");
    void this.reconcile();
    return { ...view, phase: "Deleting", reason: null };
  }

  // -------------------------------------------------------------- reconcile

  start(): void {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.config.reconcileMs);
    this.timer.unref();
  }

  /** Stops the loop and the helm processes. Interrupted installs are picked up (and failed cleanly) after a restart. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.inflight.values()) {
      entry.quiet = true;
      entry.controller.abort();
    }
    await this.idle();
  }

  /** Resolves when no install or deletion is running. For shutdown and tests. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.running) await this.running.catch(() => undefined);
      else if (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()].map((e) => e.promise));
      else return;
    }
  }

  /**
   * Runs a full pass. Calls while a pass is running coalesce into exactly one more pass that starts after the call,
   * so `await reconcile()` always means "everything that existed when I asked has been looked at".
   */
  reconcile(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.pass();
        } while (this.rerun && !this.stopping);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    try {
      for (const ns of await this.kube.listStoreNamespaces()) {
        const view = this.view(ns);
        if (!view) continue;
        if (this.stopping) return;
        try {
          if (view.phase === "Provisioning") await this.reconcileProvisioning(view);
          else if (view.phase === "Deleting") await this.reconcileDeleting(view, ns);
        } catch (err) {
          this.log.warn({ store: view.id, err: message(err) }, "reconcile step failed; will retry");
        }
      }
    } catch (err) {
      this.log.warn({ err: message(err) }, "could not list stores; will retry");
    }
  }

  private async reconcileProvisioning(v: StoreView): Promise<void> {
    const age = this.now() - Date.parse(v.createdAt);
    if (age > this.config.timeoutMs) {
      const running = this.inflight.get(v.id);
      if (running) {
        running.quiet = true;
        running.controller.abort();
      }
      await this.fail(v, `Timed out after ${Math.round(this.config.timeoutMs / 60000)} minutes waiting for the store to become ready. Delete it and try again`);
      return;
    }
    if (this.inflight.has(v.id)) return;

    await this.kube.ensureAccess(v.namespace); // idempotent; also repairs a store whose namespace was created just before a restart
    const state = await this.helm.state(v.namespace, RELEASE);
    if (state === "none") {
      this.startInstall(v, age);
    } else if (state === "deployed") {
      // Helm finished but the provisioner never recorded it (it restarted in between): verify, then record.
      if ((await this.kube.storeReady(v.namespace)).ready) await this.markReady(v);
    } else if (state === "pending") {
      await this.fail(v, "Provisioning was interrupted (the provisioner restarted while the store was installing). Delete this store and create it again");
    } else {
      await this.fail(v, "The installation failed. Delete this store and create it again; the events in its namespace explain why");
    }
  }

  private startInstall(v: StoreView, ageMs: number): void {
    if (this.stopping) return; // shutting down: leave it for the next provisioner to pick up
    const controller = new AbortController();
    const entry: Inflight = { kind: "install", controller, quiet: false, promise: Promise.resolve() };
    this.inflight.set(v.id, entry);
    entry.promise = (async () => {
      try {
        const files = await this.writeValues(v);
        if (controller.signal.aborted) return;
        await this.helm.install({
          namespace: v.namespace,
          release: RELEASE,
          chartPath: this.config.chartPath,
          valuesFiles: files,
          timeoutSeconds: Math.max(60, Math.ceil((this.config.timeoutMs - ageMs) / 1000)),
          signal: controller.signal,
        });
        if (!entry.quiet) await this.markReady(v);
      } catch (err) {
        if (entry.quiet) return;
        await this.fail(v, `Installation failed: ${message(err)}`).catch((e) => this.log.error({ store: v.id, err: message(e) }, "could not record failure"));
      } finally {
        this.inflight.delete(v.id);
      }
    })();
    this.log.info({ store: v.id, namespace: v.namespace }, "installing store");
  }

  private async reconcileDeleting(v: StoreView, ns: NamespaceObject): Promise<void> {
    if (ns.metadata.deletionTimestamp) return; // Kubernetes is already removing it
    const existing = this.inflight.get(v.id);
    if (existing?.kind === "delete") return;
    if (existing) {
      // An install was aborted by remove(); let helm exit before tearing the release down.
      existing.quiet = true;
      existing.controller.abort();
      await existing.promise.catch(() => undefined);
    }
    await this.kube.ensureAccess(v.namespace).catch((err) => this.log.warn({ store: v.id, err: message(err) }, "could not (re)grant access; trying the teardown anyway"));
    if (this.inflight.has(v.id)) return;
    const entry: Inflight = { kind: "delete", controller: new AbortController(), quiet: false, promise: Promise.resolve() };
    this.inflight.set(v.id, entry);
    entry.promise = (async () => {
      try {
        // Uninstall first for an orderly teardown, then delete the namespace, which removes volumes, Secrets and anything left over.
        await this.helm.uninstall(v.namespace, RELEASE).catch((err) => this.log.warn({ store: v.id, err: message(err) }, "helm uninstall failed; deleting the namespace anyway"));
        await this.kube.deleteNamespace(v.namespace);
        this.log.info({ store: v.id }, "store deleted");
      } catch (err) {
        this.log.warn({ store: v.id, err: message(err) }, "store deletion failed; will retry");
      } finally {
        this.inflight.delete(v.id);
      }
    })();
  }

  // ---------------------------------------------------------------- records

  private async fail(v: StoreView, reason: string): Promise<void> {
    await this.kube.annotateNamespace(v.namespace, { [ANN_PHASE]: "Failed", [ANN_REASON]: reason.slice(0, 300) });
    this.log.warn({ store: v.id, reason }, "store failed");
  }

  private async markReady(v: StoreView): Promise<void> {
    await this.kube.annotateNamespace(v.namespace, { [ANN_PHASE]: "Ready", [ANN_REASON]: null, [ANN_READY]: new Date(this.now()).toISOString() });
    this.log.info({ store: v.id }, "store ready");
  }

  /** Values files for one install: the shared base, then this store's identity. Written as JSON, so a name can hold any character. */
  private async writeValues(v: StoreView): Promise<string[]> {
    const dir = this.config.workDir;
    await mkdir(dir, { recursive: true });
    if (!this.baseValuesFile) {
      this.baseValuesFile = path.join(dir, "base-values.json");
      await writeFile(this.baseValuesFile, JSON.stringify(this.config.baseValues), { mode: 0o600 });
    }
    const file = path.join(dir, `${v.id}.json`);
    await writeFile(
      file,
      JSON.stringify({
        store: { id: v.id, name: v.name, ownerId: v.ownerId },
        domain: { base: this.config.baseDomain },
        ingress: { scheme: this.config.scheme },
      }),
      { mode: 0o600 },
    );
    return [this.baseValuesFile, file];
  }
}

