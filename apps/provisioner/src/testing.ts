import type { Helm, InstallRequest, ReleaseState } from "./helm.js";
import { KubeError, type Kube } from "./kube.js";
import type { NamespaceObject } from "./model.js";

/** In-memory Kubernetes: namespaces with labels/annotations, secrets, and a switch for "is the store ready". */
export class FakeKube implements Kube {
  namespaces = new Map<string, NamespaceObject>();
  secrets = new Map<string, string>();
  readyNamespaces = new Set<string>();
  calls: string[] = [];

  async listStoreNamespaces(): Promise<NamespaceObject[]> {
    return [...this.namespaces.values()].filter((n) => n.metadata.labels?.["mcp-portal.io/store"] === "true");
  }
  async getNamespace(name: string) {
    return this.namespaces.get(name);
  }
  async createNamespace(name: string, labels: Record<string, string>, annotations: Record<string, string>) {
    this.calls.push(`create ${name}`);
    if (this.namespaces.has(name)) throw new KubeError(409, "already exists");
    const ns: NamespaceObject = { metadata: { name, labels: { ...labels }, annotations: { ...annotations } } };
    this.namespaces.set(name, ns);
    return ns;
  }
  async annotateNamespace(name: string, annotations: Record<string, string | null>) {
    const ns = this.namespaces.get(name);
    if (!ns) throw new KubeError(404, "not found");
    const next = { ...(ns.metadata.annotations ?? {}) };
    for (const [k, v] of Object.entries(annotations)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    ns.metadata.annotations = next;
  }
  async deleteNamespace(name: string) {
    this.calls.push(`delete ${name}`);
    this.namespaces.delete(name);
  }
  accessGranted = new Set<string>();
  async ensureAccess(namespace: string) {
    this.accessGranted.add(namespace);
  }
  async readSecretKey(namespace: string, secret: string, key: string) {
    return this.secrets.get(`${namespace}/${secret}/${key}`);
  }
  async storeReady(namespace: string) {
    return this.readyNamespaces.has(namespace) ? { ready: true, detail: "ready" } : { ready: false, detail: "not yet" };
  }
  phase(id: string, prefix = "store-"): string | undefined {
    return this.namespaces.get(`${prefix}${id}`)?.metadata.annotations?.["mcp-portal.io/phase"];
  }
  reason(id: string, prefix = "store-"): string | undefined {
    return this.namespaces.get(`${prefix}${id}`)?.metadata.annotations?.["mcp-portal.io/reason"];
  }
}

interface Pending {
  req: InstallRequest;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** A Helm whose installs stay running until the test resolves or rejects them, and which honours abort signals. */
export class FakeHelm implements Helm {
  releases = new Map<string, ReleaseState>();
  pending = new Map<string, Pending>();
  installs: InstallRequest[] = [];
  uninstalls: string[] = [];

  async state(namespace: string): Promise<ReleaseState> {
    return this.releases.get(namespace) ?? "none";
  }
  install(req: InstallRequest): Promise<void> {
    this.installs.push(req);
    this.releases.set(req.namespace, "pending");
    return new Promise<void>((resolve, reject) => {
      if (req.signal.aborted) return reject(new Error("aborted"));
      this.pending.set(req.namespace, { req, resolve, reject });
      req.signal.addEventListener("abort", () => {
        this.pending.delete(req.namespace);
        reject(new Error("aborted"));
      });
    });
  }
  async uninstall(namespace: string): Promise<void> {
    this.uninstalls.push(namespace);
    this.releases.delete(namespace);
  }
  succeed(namespace: string): void {
    const p = this.pending.get(namespace);
    if (!p) throw new Error(`no install running in ${namespace}`);
    this.pending.delete(namespace);
    this.releases.set(namespace, "deployed");
    p.resolve();
  }
  fail(namespace: string, message: string): void {
    const p = this.pending.get(namespace);
    if (!p) throw new Error(`no install running in ${namespace}`);
    this.pending.delete(namespace);
    this.releases.set(namespace, "failed");
    p.reject(new Error(message));
  }
}

/** Creates a store namespace directly, as the provisioner would have before it stopped. */
export async function seedStore(kube: FakeKube, id: string, ownerId: string, phase: string, createdAt: string): Promise<void> {
  await kube.createNamespace(
    `store-${id}`,
    { "mcp-portal.io/store": "true", "mcp-portal.io/store-id": id, "mcp-portal.io/owner": ownerId },
    { "mcp-portal.io/display-name": `Store ${id}`, "mcp-portal.io/phase": phase, "mcp-portal.io/created-at": createdAt },
  );
}
