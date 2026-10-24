import { KubeError, type KubeApi } from "./kube.js";

/**
 * An in-memory stand-in for the Kubernetes API, used by unit tests, the gateway's integration
 * tests and `scripts/dev-stack.mts` (so the demo works without a cluster). It implements exactly
 * the endpoints kube-ops-mcp calls and records every PATCH so tests can assert on what was sent.
 */
export interface FakeCluster extends KubeApi {
  calls: { method: string; path: string; body?: unknown }[];
  /** Make the next calls to any path containing `fragment` fail with this error. */
  failOn(fragment: string, error: KubeError): void;
  deployments: Map<string, { replicas: number; annotations: Record<string, string> }>;
}

interface DeploymentRef {
  deploymentRef: { replicas: number; annotations: Record<string, string> };
  scale: boolean;
}
const isRef = (value: unknown): value is DeploymentRef => typeof value === "object" && value !== null && "deploymentRef" in value;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function pod(name: string, app: string, status: Record<string, unknown>, ageMs = 3_600_000) {
  return {
    metadata: { name, creationTimestamp: ago(ageMs), labels: { "app.kubernetes.io/name": app } },
    spec: { containers: [{ name: app, resources: { limits: { cpu: "200m", memory: "128Mi" } } }] },
    status,
  };
}

const running = { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] };

export function createFakeCluster(): FakeCluster {
  const calls: FakeCluster["calls"] = [];
  const failures: { fragment: string; error: KubeError }[] = [];
  const deployments: FakeCluster["deployments"] = new Map([
    ["platform/gateway", { replicas: 1, annotations: {} }],
    ["platform/currency-mcp", { replicas: 1, annotations: {} }],
    ["platform/insights-mcp", { replicas: 1, annotations: {} }],
    ["platform/kube-ops-mcp", { replicas: 1, annotations: {} }],
    ["store/woo-mcp", { replicas: 1, annotations: {} }],
    ["store/wordpress", { replicas: 1, annotations: {} }],
  ]);

  const pods: Record<string, unknown[]> = {
    platform: [
      pod("gateway-7d9f8b6c5-abcde", "gateway", running),
      pod("postgres-0", "postgres", running),
      pod("currency-mcp-5c8d7f9b44-xk2lp", "currency-mcp", {
        phase: "Running",
        containerStatuses: [
          {
            ready: false,
            restartCount: 6,
            state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 2m40s restarting failed container" } },
            lastState: { terminated: { reason: "Error", exitCode: 1, finishedAt: ago(30_000) } },
          },
        ],
      }),
    ],
    store: [pod("woo-mcp-6b7d4c9f8-q9wzt", "woo-mcp", running), pod("wordpress-8f6c5d4b7-m2n3p", "wordpress", running)],
  };

  const events: Record<string, unknown[]> = {
    platform: [
      { type: "Warning", reason: "BackOff", message: "Back-off restarting failed container currency-mcp in pod currency-mcp-5c8d7f9b44-xk2lp", count: 14, lastTimestamp: ago(20_000), involvedObject: { kind: "Pod", name: "currency-mcp-5c8d7f9b44-xk2lp" } },
      { type: "Normal", reason: "Pulled", message: "Container image already present on machine", count: 7, lastTimestamp: ago(60_000), involvedObject: { kind: "Pod", name: "currency-mcp-5c8d7f9b44-xk2lp" } },
      { type: "Normal", reason: "ScalingReplicaSet", message: "Scaled up replica set gateway-7d9f8b6c5 to 1", count: 1, lastTimestamp: ago(3_000_000), involvedObject: { kind: "Deployment", name: "gateway" } },
    ],
    store: [],
  };

  // metrics-server style usage (CPU in nanocores, memory in Ki), one entry per pod.
  const usage: Record<string, unknown[]> = {
    platform: [
      { metadata: { name: "gateway-7d9f8b6c5-abcde" }, containers: [{ name: "gateway", usage: { cpu: "23456789n", memory: "98304Ki" } }] },
      { metadata: { name: "postgres-0" }, containers: [{ name: "postgres", usage: { cpu: "9000000n", memory: "131072Ki" } }] },
      { metadata: { name: "currency-mcp-5c8d7f9b44-xk2lp" }, containers: [{ name: "currency-mcp", usage: { cpu: "1000000n", memory: "20480Ki" } }] },
    ],
    store: [
      { metadata: { name: "woo-mcp-6b7d4c9f8-q9wzt" }, containers: [{ name: "woo-mcp", usage: { cpu: "4000000n", memory: "61440Ki" } }] },
      { metadata: { name: "wordpress-8f6c5d4b7-m2n3p" }, containers: [{ name: "wordpress", usage: { cpu: "150000000n", memory: "122880Ki" } }] },
    ],
  };

  const logs: Record<string, string> = {
    "platform/currency-mcp-5c8d7f9b44-xk2lp": [
      '{"level":30,"msg":"starting currency-mcp"}',
      '{"level":60,"msg":"failed to start","err":"Missing required environment variable MCP_AUTH_TOKEN"}',
    ].join("\n"),
    "platform/gateway-7d9f8b6c5-abcde": '{"level":30,"msg":"gateway listening","port":8080}\n',
  };

  const deploymentObject = (name: string, v: { replicas: number }) => {
    const crashing = name === "currency-mcp";
    return {
      metadata: { name, generation: 3 },
      spec: { replicas: v.replicas },
      status: {
        observedGeneration: 3,
        readyReplicas: crashing ? 0 : v.replicas,
        updatedReplicas: v.replicas,
        availableReplicas: crashing ? 0 : v.replicas,
        ...(crashing
          ? {
              unavailableReplicas: v.replicas,
              conditions: [
                { type: "Available", status: "False", reason: "MinimumReplicasUnavailable", message: "Deployment does not have minimum availability." },
                { type: "Progressing", status: "True", reason: "ReplicaSetUpdated", message: 'ReplicaSet "currency-mcp-5c8d7f9b44" is progressing.' },
              ],
            }
          : { conditions: [{ type: "Available", status: "True", reason: "MinimumReplicasAvailable" }] }),
      },
    };
  };

  const find = (method: string, path: string): unknown => {
    for (const f of failures) if (path.includes(f.fragment)) throw f.error;
    const url = new URL(path, "http://fake");
    const p = url.pathname;
    let m: RegExpExecArray | null;

    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/pods$/.exec(p))) return { items: pods[m[1]!] ?? [] };
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/events$/.exec(p))) {
      const wanted = /^involvedObject\.name=(.+)$/.exec(url.searchParams.get("fieldSelector") ?? "")?.[1];
      return { items: (events[m[1]!] ?? []).filter((e) => !wanted || (e as { involvedObject: { name: string } }).involvedObject.name === wanted) };
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/.exec(p))) {
      const text = logs[`${m[1]}/${decodeURIComponent(m[2]!)}`];
      if (text === undefined) throw new KubeError(404, `pods "${m[2]}" not found`);
      return text;
    }
    if ((m = /^\/apis\/metrics\.k8s\.io\/v1beta1\/namespaces\/([^/]+)\/pods$/.exec(p))) {
      return { items: (usage[m[1]!] ?? []) };
    }
    if ((m = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/deployments$/.exec(p))) {
      const ns = m[1]!;
      const items = [...deployments].filter(([k]) => k.startsWith(`${ns}/`)).map(([k, v]) => deploymentObject(k.split("/")[1]!, v));
      return { items };
    }
    if ((m = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/deployments\/([^/]+)(\/scale)?$/.exec(p))) {
      const key = `${m[1]}/${decodeURIComponent(m[2]!)}`;
      const d = deployments.get(key);
      if (!d) throw new KubeError(404, `deployments.apps "${m[2]}" not found`);
      return { deploymentRef: d, scale: Boolean(m[3]) } satisfies DeploymentRef;
    }
    throw new KubeError(404, `the server could not find the requested resource (${method} ${p})`);
  };

  return {
    calls,
    deployments,
    failOn: (fragment, error) => void failures.push({ fragment, error }),
    getJson: async <T>(path: string) => {
      calls.push({ method: "GET", path });
      const r = find("GET", path);
      if (isRef(r)) return (r.scale ? { spec: { replicas: r.deploymentRef.replicas } } : deploymentObject(path.split("/deployments/")[1]!.split("?")[0]!, r.deploymentRef)) as T;
      return r as T;
    },
    getText: async (path) => {
      calls.push({ method: "GET", path });
      return find("GET", path) as string;
    },
    patchJson: async <T>(path: string, body: unknown) => {
      calls.push({ method: "PATCH", path, body });
      const r = find("PATCH", path);
      if (!isRef(r)) throw new KubeError(405, `PATCH is not supported on ${path}`);
      const b = body as { spec?: { replicas?: number; template?: { metadata?: { annotations?: Record<string, string> } } } };
      if (r.scale && typeof b.spec?.replicas === "number") r.deploymentRef.replicas = b.spec.replicas;
      const annotations = b.spec?.template?.metadata?.annotations;
      if (!r.scale && annotations) Object.assign(r.deploymentRef.annotations, annotations);
      return {} as T;
    },
  };
}
