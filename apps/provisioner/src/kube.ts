import { readFileSync } from "node:fs";
import https from "node:https";
import type { NamespaceObject } from "./model.js";

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KubeError";
  }
}

/** Everything the provisioner needs from the Kubernetes API. A narrow interface keeps it testable and auditable. */
export interface Kube {
  listStoreNamespaces(): Promise<NamespaceObject[]>;
  getNamespace(name: string): Promise<NamespaceObject | undefined>;
  createNamespace(name: string, labels: Record<string, string>, annotations: Record<string, string>): Promise<NamespaceObject>;
  /** Merge-patches annotations (a null value removes one). */
  annotateNamespace(name: string, annotations: Record<string, string | null>): Promise<void>;
  deleteNamespace(name: string): Promise<void>;
  /**
   * Idempotently binds the provisioner to the namespaced `mcp-store-admin` ClusterRole inside one store namespace, so
   * Helm can manage that namespace and nothing else. (An admission policy limits where this binding can exist.)
   */
  ensureAccess(namespace: string): Promise<void>;
  readSecretKey(namespace: string, secret: string, key: string): Promise<string | undefined>;
  /** True when the store's WordPress and woo-mcp are available and the setup Job has completed. */
  storeReady(namespace: string): Promise<{ ready: boolean; detail: string }>;
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

interface Raw {
  status: number;
  body: string;
}

function rawRequest(method: string, path: string, body: unknown, contentType: string | undefined, agent: https.Agent, host: string, port: string, tokenPath: string): Promise<Raw> {
  return new Promise<Raw>((resolve, reject) => {
    let token: string;
    try {
      token = readFileSync(tokenPath, "utf8").trim();
    } catch {
      reject(new KubeError(503, "The ServiceAccount token is not mounted"));
      return;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        host,
        port,
        path,
        method,
        agent,
        timeout: 15000,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(payload ? { "content-type": contentType ?? "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 4 * 1024 * 1024) req.destroy(new KubeError(502, "The Kubernetes API response was too large"));
          else chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => reject(new KubeError(502, e.message)));
      },
    );
    req.on("timeout", () => req.destroy(new KubeError(504, "Timed out talking to the Kubernetes API")));
    req.on("error", (e) => reject(e instanceof KubeError ? e : new KubeError(503, `Cannot reach the Kubernetes API: ${e.message}`)));
    req.end(payload);
  });
}

const msg = (r: Raw): string => {
  try {
    const m = (JSON.parse(r.body) as { message?: unknown }).message;
    if (typeof m === "string") return m.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return `Kubernetes API returned HTTP ${r.status}`;
};

export function inClusterKube(): Kube {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("Not running inside a cluster: KUBERNETES_SERVICE_HOST is not set");
  const agent = new https.Agent({ ca: readFileSync(`${SA_DIR}/ca.crt`), keepAlive: true, maxSockets: 8 });
  const tokenPath = `${SA_DIR}/token`;
  const call = (method: string, path: string, body?: unknown, ct?: string) => rawRequest(method, path, body, ct, agent, host, port, tokenPath);
  const seg = (s: string) => encodeURIComponent(s);
  const json = <T>(r: Raw): T => JSON.parse(r.body) as T;

  return {
    async listStoreNamespaces() {
      const r = await call("GET", `/api/v1/namespaces?labelSelector=${encodeURIComponent("mcp-portal.io/store=true")}`);
      if (r.status !== 200) throw new KubeError(r.status, msg(r));
      return json<{ items?: NamespaceObject[] }>(r).items ?? [];
    },
    async getNamespace(name) {
      const r = await call("GET", `/api/v1/namespaces/${seg(name)}`);
      if (r.status === 404) return undefined;
      if (r.status !== 200) throw new KubeError(r.status, msg(r));
      return json<NamespaceObject>(r);
    },
    async createNamespace(name, labels, annotations) {
      const r = await call("POST", "/api/v1/namespaces", { apiVersion: "v1", kind: "Namespace", metadata: { name, labels, annotations } });
      if (r.status !== 201 && r.status !== 200) throw new KubeError(r.status, msg(r));
      return json<NamespaceObject>(r);
    },
    async annotateNamespace(name, annotations) {
      const r = await call("PATCH", `/api/v1/namespaces/${seg(name)}`, { metadata: { annotations } }, "application/merge-patch+json");
      if (r.status !== 200) throw new KubeError(r.status, msg(r));
    },
    async deleteNamespace(name) {
      const r = await call("DELETE", `/api/v1/namespaces/${seg(name)}`);
      if (r.status !== 200 && r.status !== 202 && r.status !== 404) throw new KubeError(r.status, msg(r));
    },
    async ensureAccess(namespace) {
      const ns = seg(namespace);
      const r = await call("POST", `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`, {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: "mcp-store-provisioner", namespace, labels: { "app.kubernetes.io/managed-by": "mcp-provisioner" } },
        subjects: [{ kind: "ServiceAccount", name: process.env.POD_SERVICE_ACCOUNT ?? "provisioner", namespace: process.env.POD_NAMESPACE ?? "platform" }],
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "mcp-store-admin" },
      });
      if (r.status !== 201 && r.status !== 200 && r.status !== 409) throw new KubeError(r.status, msg(r));
    },
    async readSecretKey(namespace, secret, key) {
      const r = await call("GET", `/api/v1/namespaces/${seg(namespace)}/secrets/${seg(secret)}`);
      if (r.status === 404) return undefined;
      if (r.status !== 200) throw new KubeError(r.status, msg(r));
      const value = json<{ data?: Record<string, string> }>(r).data?.[key];
      return value === undefined ? undefined : Buffer.from(value, "base64").toString("utf8");
    },
    async storeReady(namespace) {
      const ns = seg(namespace);
      for (const name of ["wordpress", "woo-mcp"]) {
        const r = await call("GET", `/apis/apps/v1/namespaces/${ns}/deployments/${name}`);
        if (r.status === 404) return { ready: false, detail: `${name} does not exist yet` };
        if (r.status !== 200) throw new KubeError(r.status, msg(r));
        const d = json<{ spec?: { replicas?: number }; status?: { availableReplicas?: number } }>(r);
        if ((d.status?.availableReplicas ?? 0) < Math.max(1, d.spec?.replicas ?? 1)) return { ready: false, detail: `${name} is not available yet` };
      }
      const j = await call("GET", `/apis/batch/v1/namespaces/${ns}/jobs/wordpress-setup`);
      if (j.status === 404) return { ready: false, detail: "the WooCommerce setup job has not started" };
      if (j.status !== 200) throw new KubeError(j.status, msg(j));
      if ((json<{ status?: { succeeded?: number } }>(j).status?.succeeded ?? 0) < 1) return { ready: false, detail: "the WooCommerce setup job is still running" };
      return { ready: true, detail: "ready" };
    },
  };
}
