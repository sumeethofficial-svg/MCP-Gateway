import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/principal.js";
import { createEnv, startKubeOps, textOf, type TestEnv } from "./harness.js";

const names = async (env: TestEnv, p: Principal) => (await env.c.gateway.listVisibleTools(p)).tools.map((t) => t.name);
const json = (r: { structuredContent?: unknown }) => r.structuredContent as any;

describe("kube-ops behind the gateway", () => {
  let env: TestEnv;
  let ops: Awaited<ReturnType<typeof startKubeOps>>;
  let admin: Principal;
  let sid: Principal; // a member

  beforeAll(async () => {
    env = await createEnv();
    ops = await startKubeOps();
    admin = await env.makeUser("admin", "admin@example.com");
    sid = await env.makeUser("member", "sid@example.com");
    // Mirrors the Helm seeding: kube-ops is trusted for annotations, so its read tools reach members and its write tools do not.
    await env.addUpstream(ops, "kube-ops", { trust: true });
  });

  afterAll(async () => {
    await ops.close();
    await env.cleanup();
  });

  it("passes the gateway's tool-poisoning scan and is approved on first sight", async () => {
    const snapshots = (await env.c.catalog.snapshot()).filter((s) => s.server.slug === "kube-ops");
    expect(snapshots.map((s) => s.ok)).toEqual([true]);
    const entries = snapshots.flatMap((s) => s.entries);
    expect(entries.map((e) => e.exposedName).sort()).toEqual(
      [
        "kube-ops__get_deployment_status",
        "kube-ops__get_events",
        "kube-ops__get_pod_health",
        "kube-ops__get_pod_logs",
        "kube-ops__get_pod_restarts",
        "kube-ops__get_resource_metrics",
        "kube-ops__list_deployments",
        "kube-ops__list_pods",
        "kube-ops__restart_deployment",
        "kube-ops__scale_deployment",
      ].sort(),
    );
    for (const entry of entries) {
      expect(entry.pin.flags, `${entry.exposedName} should be clean`).toEqual([]);
      expect(entry.pin.status).toBe("approved");
    }
  });

  it("shows a member the read tools only", async () => {
    const list = await names(env, sid);
    expect(list).toEqual(
      expect.arrayContaining([
        "kube-ops__list_pods",
        "kube-ops__list_deployments",
        "kube-ops__get_events",
        "kube-ops__get_pod_logs",
        "kube-ops__get_pod_health",
        "kube-ops__get_pod_restarts",
        "kube-ops__get_deployment_status",
        "kube-ops__get_resource_metrics",
      ]),
    );
    expect(list).not.toContain("kube-ops__restart_deployment");
    expect(list).not.toContain("kube-ops__scale_deployment");

    const adminList = await names(env, admin);
    expect(adminList).toEqual(expect.arrayContaining(["kube-ops__restart_deployment", "kube-ops__scale_deployment"]));
  });

  it("the demo: a member is refused the fix, the admin applies it, and the cluster only ever sees the admin's request", async () => {
    const args = { namespace: "platform", deployment: "currency-mcp", reason: "currency-mcp is crash looping after the last config change" };

    const refused = await env.c.gateway.callTool(sid, "kube-ops__restart_deployment", args);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/Not permitted.*can change data/);
    expect(ops.cluster.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

    const done = await env.c.gateway.callTool(admin, "kube-ops__restart_deployment", args);
    expect(done.isError).toBeFalsy();
    expect(json(done)).toMatchObject({ restarted: true, deployment: "currency-mcp" });
    const patches = ops.cluster.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.path).toBe("/apis/apps/v1/namespaces/platform/deployments/currency-mcp");

    const denied = await env.c.audit.query({ userId: sid.userId, outcome: "denied" });
    expect(denied.rows[0]).toMatchObject({ userEmail: "sid@example.com", exposedName: "kube-ops__restart_deployment", outcome: "denied" });
    const allowed = await env.c.audit.query({ userId: admin.userId, tool: "restart_deployment" });
    expect(allowed.rows[0]).toMatchObject({ userEmail: "admin@example.com", outcome: "ok" });
    expect(allowed.rows[0]!.argsPreview).toContain("crash looping");
  });

  it("lets a member read the cluster, and the diagnosis is there for anyone to find", async () => {
    const health = await env.c.gateway.callTool(sid, "kube-ops__get_pod_health", { namespace: "platform" });
    expect(json(health)).toMatchObject({ verdict: "degraded", unhealthy: 1 });
    expect(json(health).pods[0]).toMatchObject({ app: "currency-mcp", state: "CrashLoopBackOff", healthy: false });

    const status = await env.c.gateway.callTool(sid, "kube-ops__get_deployment_status", { namespace: "platform", deployment: "currency-mcp" });
    expect(json(status)).toMatchObject({ verdict: "degraded", can_change: true });

    const logs = await env.c.gateway.callTool(sid, "kube-ops__get_pod_logs", { namespace: "platform", pod: "currency-mcp-5c8d7f9b44-xk2lp", previous: true });
    expect(json(logs).lines.join("\n")).toMatch(/Missing required environment variable MCP_AUTH_TOKEN/);
  });
});
