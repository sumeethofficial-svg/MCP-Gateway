/** What the provisioner reports about a store. Mirrors apps/provisioner/src/model.ts (kept separate: they are different deployables). */
export type StorePhase = "Provisioning" | "Ready" | "Failed" | "Deleting";

export interface StoreInfo {
  id: string;
  name: string;
  namespace: string;
  phase: StorePhase;
  reason: string | null;
  url: string;
  ownerId: string;
  ownerEmail: string | null;
  createdAt: string;
}

export interface CreateStoreRequest {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail?: string;
}

/** The gateway's whole view of the provisioner. Narrow on purpose, so tests can replace it with a fake. */
export interface ProvisionerClient {
  list(): Promise<StoreInfo[]>;
  get(id: string): Promise<StoreInfo | undefined>;
  create(input: CreateStoreRequest): Promise<{ store: StoreInfo; created: boolean }>;
  remove(id: string): Promise<StoreInfo>;
  /** In-cluster address and bearer token of a Ready store's woo-mcp. */
  mcpEndpoint(id: string): Promise<{ url: string; token: string }>;
}

export class ProvisionerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionerError";
  }
}

export function httpProvisioner(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): ProvisionerClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
      throw new ProvisionerError(503, "provisioner_unavailable", timedOut ? "The store provisioner did not answer in time" : "The store provisioner is not reachable");
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      // Only 4xx messages are written for end users; anything else is reported generically.
      if (res.status >= 400 && res.status < 500 && typeof e?.message === "string") throw new ProvisionerError(res.status, typeof e.code === "string" ? e.code : "rejected", e.message.slice(0, 300));
      throw new ProvisionerError(502, "provisioner_error", "The store provisioner could not complete the request");
    }
    return json as T;
  }

  return {
    async list() {
      return (await call<{ stores: StoreInfo[] }>("GET", "/stores")).stores;
    },
    async get(id) {
      try {
        return (await call<{ store: StoreInfo }>("GET", `/stores/${encodeURIComponent(id)}`)).store;
      } catch (err) {
        if (err instanceof ProvisionerError && err.status === 404) return undefined;
        throw err;
      }
    },
    create: (input) => call("POST", "/stores", input),
    async remove(id) {
      return (await call<{ store: StoreInfo }>("DELETE", `/stores/${encodeURIComponent(id)}`)).store;
    },
    mcpEndpoint: (id) => call("GET", `/stores/${encodeURIComponent(id)}/mcp`),
  };
}
