import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { StoreError, StoreManager } from "./manager.js";
import { FakeHelm, FakeKube, seedStore } from "./testing.js";

const log = pino({ level: "silent" });
const owner = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function setup(overrides: Partial<Config> = {}) {
  const kube = new FakeKube();
  const helm = new FakeHelm();
  const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
  const config: Config = {
    port: 0,
    token: "t".repeat(32),
    nsPrefix: "store-",
    baseDomain: "stores.localtest.me",
    scheme: "http",
    maxPerUser: 2,
    maxTotal: 4,
    timeoutMs: 20 * 60_000,
    reconcileMs: 1000,
    chartPath: "/charts/mcp-store",
    baseValues: { image: { tag: "dev" } },
    helmBin: "helm",
    workDir: mkdtempSync(path.join(tmpdir(), "prov-")),
    ...overrides,
  };
  const make = () => new StoreManager(kube, helm, config, log, () => clock.t);
  return { kube, helm, clock, config, mgr: make(), make };
}

const req = (id: string, ownerId = owner(1), name = `Store ${id}`) => ({ id, name, ownerId, ownerEmail: "a@example.com" });
/** Installs start asynchronously (the values files are written first), so tests wait for helm to be running. */
const installing = (s: { helm: FakeHelm }, ns: string) => vi.waitFor(() => expect(s.helm.pending.has(ns)).toBe(true));
const expectError = async (p: Promise<unknown>, status: number, code: string) => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(StoreError);
  expect(err).toMatchObject({ status, code });
};

describe("creating stores", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("creates a labelled namespace in Provisioning, then installs and marks it Ready", async () => {
    const { store, created } = await s.mgr.create(req("berlin"));
    expect(created).toBe(true);
    expect(store).toMatchObject({ id: "berlin", namespace: "store-berlin", phase: "Provisioning", url: "http://berlin.stores.localtest.me", ownerId: owner(1) });
    const ns = s.kube.namespaces.get("store-berlin")!;
    expect(ns.metadata.labels).toMatchObject({ "mcp-portal.io/store": "true", "mcp-portal.io/owner": owner(1), "pod-security.kubernetes.io/enforce": "baseline" });

    await s.mgr.reconcile();
    await installing(s, "store-berlin");
    expect(s.helm.installs).toHaveLength(1);
    expect(s.helm.installs[0]).toMatchObject({ namespace: "store-berlin", release: "store", chartPath: "/charts/mcp-store" });
    expect(s.kube.phase("berlin")).toBe("Provisioning");

    s.helm.succeed("store-berlin");
    await s.mgr.idle();
    expect(s.kube.phase("berlin")).toBe("Ready");
    expect((await s.mgr.get("berlin"))!.phase).toBe("Ready");
  });

  it("provisions several stores at the same time", async () => {
    await s.mgr.create(req("alpha"));
    await s.mgr.create(req("beta", owner(2)));
    await s.mgr.create(req("gamma", owner(3)));
    await s.mgr.reconcile();
    await vi.waitFor(() => expect(s.helm.pending.size).toBe(3));
    s.helm.succeed("store-beta");
    s.helm.succeed("store-alpha");
    s.helm.succeed("store-gamma");
    await s.mgr.idle();
    expect((await s.mgr.list()).map((x) => x.phase)).toEqual(["Ready", "Ready", "Ready"]);
  });

  it("is safe to retry: the same request returns the same store and never installs twice", async () => {
    const first = await s.mgr.create(req("berlin"));
    const again = await s.mgr.create(req("berlin"));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    await s.mgr.reconcile();
    await installing(s, "store-berlin");
    await s.mgr.reconcile();
    await s.mgr.reconcile();
    expect(s.helm.installs).toHaveLength(1);
    expect(s.kube.calls.filter((c) => c === "create store-berlin")).toHaveLength(1);
  });

  it("serialises concurrent identical requests (a double click)", async () => {
    const results = await Promise.all([s.mgr.create(req("berlin")), s.mgr.create(req("berlin")), s.mgr.create(req("berlin"))]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(s.kube.calls.filter((c) => c === "create store-berlin")).toHaveLength(1);
  });

  it("refuses an id that belongs to someone else without revealing whose", async () => {
    await s.mgr.create(req("berlin"));
    await expectError(s.mgr.create(req("berlin", owner(2))), 409, "id_taken");
  });

  it("limits stores per user and in total", async () => {
    await s.mgr.create(req("a1"));
    await s.mgr.create(req("a2"));
    await expectError(s.mgr.create(req("a3")), 409, "store_limit");
    await s.mgr.create(req("b1", owner(2)));
    await s.mgr.create(req("b2", owner(2)));
    await expectError(s.mgr.create(req("c1", owner(3))), 409, "store_limit_total");
  });

  it("does not count a store being deleted against the limit", async () => {
    await s.mgr.create(req("a1"));
    await s.mgr.create(req("a2"));
    await s.mgr.remove("a1");
    await vi.waitFor(() => expect(s.kube.namespaces.has("store-a1")).toBe(false));
    await s.mgr.create(req("a3"));
    await s.mgr.stop();
  });

  it("validates ids, names and owners", async () => {
    for (const id of ["Berlin", "-x", "x-", "a".repeat(19), "a--b", "platform", "has space", "../x"]) {
      await expectError(s.mgr.create(req(id)), 400, "invalid_id");
    }
    await expectError(s.mgr.create({ ...req("ok"), name: "  " }), 400, "invalid_name");
    await expectError(s.mgr.create({ ...req("ok"), ownerId: "bad owner!" }), 400, "invalid_owner");
  });
});

describe("namespace access", () => {
  it("grants the provisioner access to a store namespace before installing, and again after a restart", async () => {
    const s = setup();
    await seedStore(s.kube, "berlin", owner(1), "Provisioning", new Date(s.clock.t).toISOString()); // namespace made, binding never created
    await s.mgr.reconcile();
    await installing(s, "store-berlin");
    expect(s.kube.accessGranted.has("store-berlin")).toBe(true);
    await s.mgr.stop();
  });
});

describe("failures and guardrails", () => {
  it("reports a failed install with a clear, bounded reason", async () => {
    const s = setup();
    await s.mgr.create(req("berlin"));
    await s.mgr.reconcile();
    await installing(s, "store-berlin");
    s.helm.fail("store-berlin", "Error: INSTALLATION FAILED: pods \"wordpress\" is forbidden: exceeded quota\u0007");
    await s.mgr.idle();
    expect(s.kube.phase("berlin")).toBe("Failed");
    expect(s.kube.reason("berlin")).toMatch(/^Installation failed: .*exceeded quota/);
    expect(s.kube.reason("berlin")).not.toMatch(/[\u0000-\u001f]/);
    // A failed store stays visible (with its reason) and is not retried behind the user's back.
    await s.mgr.reconcile();
    expect(s.helm.installs).toHaveLength(1);
  });

  it("times out: aborts helm and fails with a reason", async () => {
    const s = setup();
    await s.mgr.create(req("slow"));
    await s.mgr.reconcile();
    await installing(s, "store-slow");
    s.clock.t += 21 * 60_000;
    await s.mgr.reconcile();
    await s.mgr.idle();
    expect(s.kube.phase("slow")).toBe("Failed");
    expect(s.kube.reason("slow")).toMatch(/Timed out after 20 minutes/);
    expect(s.helm.pending.size).toBe(0);
  });

  it("gives helm only the time that is left", async () => {
    const s = setup();
    await seedStore(s.kube, "late", owner(1), "Provisioning", new Date(s.clock.t - 10 * 60_000).toISOString());
    await s.mgr.reconcile();
    await installing(s, "store-late");
    expect(s.helm.installs[0]!.timeoutSeconds).toBe(600);
  });
});

describe("recovery after the provisioner restarts", () => {
  it("fails an interrupted install cleanly instead of leaving it Provisioning forever", async () => {
    const s = setup();
    await s.mgr.create(req("berlin"));
    await s.mgr.reconcile();
    await installing(s, "store-berlin");
    await s.mgr.stop(); // the pod is killed mid-install; helm leaves the release pending
    expect(s.helm.releases.get("store-berlin")).toBe("pending");

    const restarted = s.make();
    await restarted.reconcile();
    expect(s.kube.phase("berlin")).toBe("Failed");
    expect(s.kube.reason("berlin")).toMatch(/interrupted/);
    expect(s.helm.installs).toHaveLength(1);
  });

  it("starts the install when the provisioner died before helm ever ran", async () => {
    const s = setup();
    await seedStore(s.kube, "berlin", owner(1), "Provisioning", new Date(s.clock.t).toISOString()); // namespace exists, no release
    const restarted = s.make();
    await restarted.reconcile();
    await installing(s, "store-berlin");
    expect(s.helm.installs).toHaveLength(1);
    s.helm.succeed("store-berlin");
    await restarted.idle();
    expect(s.kube.phase("berlin")).toBe("Ready");
  });

  it("completes a store whose install finished while the provisioner was down", async () => {
    const s = setup();
    await seedStore(s.kube, "berlin", owner(1), "Provisioning", new Date(s.clock.t).toISOString());
    s.helm.releases.set("store-berlin", "deployed");
    const restarted = s.make();
    await restarted.reconcile();
    expect(s.kube.phase("berlin")).toBe("Provisioning"); // deployed, but the workloads are not ready yet
    s.kube.readyNamespaces.add("store-berlin");
    await restarted.reconcile();
    expect(s.kube.phase("berlin")).toBe("Ready");
    expect(s.helm.installs).toHaveLength(0);
  });

  it("finishes a deletion that was interrupted", async () => {
    const s = setup();
    await seedStore(s.kube, "berlin", owner(1), "Deleting", new Date(s.clock.t).toISOString()); // the old process died before deleting anything
    const restarted = s.make();
    await restarted.reconcile();
    await restarted.idle();
    expect(s.kube.namespaces.has("store-berlin")).toBe(false);
  });
});

describe("deleting stores", () => {
  it("uninstalls the release and deletes the namespace", async () => {
    const s = setup();
    await s.mgr.create(req("berlin"));
    await s.mgr.reconcile();
    await installing(s, "store-berlin");
    s.helm.succeed("store-berlin");
    await s.mgr.idle();

    const view = await s.mgr.remove("berlin");
    expect(view.phase).toBe("Deleting");
    await s.mgr.idle();
    expect(s.helm.uninstalls).toEqual(["store-berlin"]);
    expect(s.kube.namespaces.has("store-berlin")).toBe(false);
    expect(await s.mgr.list()).toEqual([]);
  });

  it("is idempotent and 404s for unknown stores", async () => {
    const s = setup();
    await s.mgr.create(req("berlin"));
    await s.mgr.remove("berlin");
    await s.mgr.idle();
    await expectError(s.mgr.remove("berlin"), 404, "not_found");
    await expectError(s.mgr.remove("never-existed"), 404, "not_found");
  });

  it("cancels an install that is still running", async () => {
    const s = setup();
    await s.mgr.create(req("berlin"));
    await s.mgr.reconcile();
    await installing(s, "store-berlin");
    await s.mgr.remove("berlin");
    await s.mgr.idle();
    expect(s.helm.pending.size).toBe(0);
    expect(s.kube.namespaces.has("store-berlin")).toBe(false);
  });

  it("still deletes the namespace when helm uninstall fails", async () => {
    const s = setup();
    await s.mgr.create(req("berlin"));
    s.helm.uninstall = async () => {
      throw new Error("boom");
    };
    await s.mgr.remove("berlin");
    await s.mgr.idle();
    expect(s.kube.namespaces.has("store-berlin")).toBe(false);
  });
});

describe("handing the store to the gateway", () => {
  it("returns the in-cluster MCP address and token only once the store is Ready", async () => {
    const s = setup();
    await s.mgr.create(req("berlin"));
    await expectError(s.mgr.mcpEndpoint("berlin"), 409, "not_ready");
    await s.mgr.reconcile();
    await installing(s, "store-berlin");
    s.helm.succeed("store-berlin");
    await s.mgr.idle();
    await expectError(s.mgr.mcpEndpoint("berlin"), 409, "not_ready"); // no token secret yet
    s.kube.secrets.set("store-berlin/woo-mcp-auth/token", "tok-123");
    expect(await s.mgr.mcpEndpoint("berlin")).toEqual({ url: "http://woo-mcp.store-berlin.svc.cluster.local:8080/mcp", token: "tok-123" });
    await expectError(s.mgr.mcpEndpoint("nope"), 404, "not_found");
  });

  it("lists only an owner's stores when asked", async () => {
    const s = setup();
    await s.mgr.create(req("a1"));
    await s.mgr.create(req("b1", owner(2)));
    expect((await s.mgr.list(owner(1))).map((x) => x.id)).toEqual(["a1"]);
    expect((await s.mgr.list()).map((x) => x.id).sort()).toEqual(["a1", "b1"]);
  });
});
