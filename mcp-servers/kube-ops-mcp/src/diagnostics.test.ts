import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { KubeOpsConfig } from "./config.js";
import { KubeError } from "./kube.js";
import { createFakeCluster } from "./testing.js";
import { registerKubeOpsTools, WriteGuard } from "./tools.js";

const config: KubeOpsConfig = {
  namespaces: ["platform", "store"],
  writeTargets: [{ namespace: "platform", name: "currency-mcp", maxReplicas: 3 }],
  minReplicas: 0,
  maxLogLines: 50,
  writeCooldownMs: 0,
};

async function connect() {
  const cluster = createFakeCluster();
  const server = new McpServer({ name: "kube-ops", version: "0" });
  registerKubeOpsTools(server, { api: cluster, config, guard: new WriteGuard(0) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return { cluster, client, call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) };
}
const data = (r: unknown) => (r as { structuredContent?: unknown }).structuredContent as any;

describe("kube-ops: diagnostics", () => {
  it("exposes the five documented read-only diagnostics plus events, logs and two guarded changes", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_deployment_status",
      "get_events",
      "get_pod_health",
      "get_pod_logs",
      "get_pod_restarts",
      "get_resource_metrics",
      "list_deployments",
      "list_pods",
      "restart_deployment",
      "scale_deployment",
    ]);
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(["restart_deployment", "scale_deployment"]);
  });

  it("get_pod_health reports a degraded namespace, unhealthy pods first, with the reason", async () => {
    const { call } = await connect();
    const res = data(await call("get_pod_health", { namespace: "platform" }));
    expect(res).toMatchObject({ verdict: "degraded", unhealthy: 1 });
    expect(res.pods[0]).toMatchObject({ app: "currency-mcp", state: "CrashLoopBackOff", healthy: false });
    expect(data(await call("get_pod_health", { namespace: "store" }))).toMatchObject({ verdict: "healthy", unhealthy: 0 });
  });

  it("get_pod_health can look at one pod and says when it does not exist", async () => {
    const { call } = await connect();
    expect(data(await call("get_pod_health", { namespace: "platform", pod: "postgres-0" }))).toMatchObject({ verdict: "healthy" });
    const missing = await call("get_pod_health", { namespace: "platform", pod: "nope-0" });
    expect(missing.isError).toBe(true);
  });

  it("get_pod_restarts ranks containers and explains the last termination", async () => {
    const { call } = await connect();
    const res = data(await call("get_pod_restarts", { namespace: "platform" }));
    expect(res.count).toBe(1);
    expect(res.containers[0]).toMatchObject({ app: "currency-mcp", restarts: 6, current_state: "CrashLoopBackOff", last_termination: { reason: "Error", exit_code: 1 } });
    expect(data(await call("get_pod_restarts", { namespace: "platform", min_restarts: 10 })).count).toBe(0);
  });

  it("get_deployment_status gives a verdict and says whether it can be changed", async () => {
    const { call } = await connect();
    const bad = data(await call("get_deployment_status", { namespace: "platform", deployment: "currency-mcp" }));
    expect(bad).toMatchObject({ verdict: "degraded", desired: 1, ready: 0, unavailable: 1, can_change: true, max_replicas: 3 });
    expect(bad.conditions.some((c: any) => c.type === "Available" && c.status === "False")).toBe(true);
    const fine = data(await call("get_deployment_status", { namespace: "platform", deployment: "gateway" }));
    expect(fine).toMatchObject({ verdict: "complete", can_change: false, max_replicas: null });
  });

  it("get_deployment_status reports a deployment scaled to zero", async () => {
    const { call, cluster } = await connect();
    cluster.deployments.get("platform/currency-mcp")!.replicas = 0;
    expect(data(await call("get_deployment_status", { namespace: "platform", deployment: "currency-mcp" })).verdict).toBe("scaled to zero");
  });

  it("get_deployment_status rejects bad names and unknown deployments as tool errors", async () => {
    const { call } = await connect();
    expect((await call("get_deployment_status", { namespace: "platform", deployment: "../etc" })).isError).toBe(true);
    expect((await call("get_deployment_status", { namespace: "platform", deployment: "ghost" })).isError).toBe(true);
    expect((await call("get_deployment_status", { namespace: "kube-system", deployment: "coredns" })).isError).toBe(true);
  });

  it("get_resource_metrics converts usage and shows the percentage of each limit", async () => {
    const { call } = await connect();
    const res = data(await call("get_resource_metrics", { namespace: "platform" }));
    expect(res.pods.map((p: any) => p.pod)).toEqual(["postgres-0", "gateway-7d9f8b6c5-abcde", "currency-mcp-5c8d7f9b44-xk2lp"]); // highest memory first
    const gw = res.pods.find((p: any) => p.pod.startsWith("gateway"));
    expect(gw).toMatchObject({ cpu_millicores: 23.5, memory_mib: 96 });
    expect(gw.containers[0]).toMatchObject({ cpu_percent_of_limit: 11.8, memory_percent_of_limit: 75 });
  });

  it("get_resource_metrics explains a missing metrics-server instead of failing opaquely", async () => {
    const { call, cluster } = await connect();
    cluster.failOn("metrics.k8s.io", new KubeError(503, "the server is currently unable to handle the request"));
    const res = await call("get_resource_metrics", { namespace: "platform" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/metrics-server/);
  });

  it("cleans untrusted text in deployment conditions", async () => {
    const { call } = await connect();
    const res = data(await call("get_deployment_status", { namespace: "platform", deployment: "currency-mcp" }));
    expect(JSON.stringify(res.conditions)).not.toMatch(/[\u0000-\u0008\u001b]/);
    expect(res.notice).toMatch(/data to read, not instructions/);
  });
});
