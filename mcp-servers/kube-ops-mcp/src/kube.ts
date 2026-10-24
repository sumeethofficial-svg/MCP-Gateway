import { readFileSync } from "node:fs";
import https from "node:https";

/** A failure talking to the Kubernetes API. `status` is the HTTP status, or 502/503/504 for transport problems. */
export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KubeError";
  }
}

/**
 * The only operations this server needs. Keeping the surface this small makes it easy to
 * reason about (and test) what the server can possibly do to a cluster: three verbs, and
 * the RBAC Role grants no more than that.
 */
export interface KubeApi {
  getJson<T = unknown>(path: string): Promise<T>;
  getText(path: string): Promise<string>;
  patchJson<T = unknown>(path: string, body: unknown, kind: "strategic" | "merge"): Promise<T>;
}

const PATCH_CONTENT_TYPE = {
  strategic: "application/strategic-merge-patch+json",
  merge: "application/merge-patch+json",
} as const;

export interface InClusterOptions {
  host?: string;
  port?: string;
  tokenPath?: string;
  caPath?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** Pulls the human-readable message out of a Kubernetes `Status` body (falls back to a short excerpt). */
export function statusMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message.slice(0, 400);
  } catch {
    // not JSON
  }
  const excerpt = body.trim().slice(0, 200);
  return excerpt || `Kubernetes API returned HTTP ${status}`;
}

/**
 * Talks to the API server with this pod's own ServiceAccount. The token file is re-read on
 * every request because projected tokens are rotated by the kubelet. Uses node:https with the
 * cluster CA rather than a Kubernetes client library: one small file to audit, no extra dependencies.
 */
export function inClusterApi(opts: InClusterOptions = {}): KubeApi {
  const host = opts.host ?? process.env.KUBERNETES_SERVICE_HOST;
  const port = opts.port ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("Not running inside a cluster: KUBERNETES_SERVICE_HOST is not set");
  const tokenPath = opts.tokenPath ?? `${SA_DIR}/token`;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const agent = new https.Agent({ ca: readFileSync(opts.caPath ?? `${SA_DIR}/ca.crt`), keepAlive: true, maxSockets: 8 });

  const request = (method: string, path: string, body?: unknown, contentType?: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let token: string;
      try {
        token = readFileSync(tokenPath, "utf8").trim();
      } catch {
        reject(new KubeError(503, "The ServiceAccount token is not mounted (automountServiceAccountToken must be true for this pod)"));
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
          timeout: timeoutMs,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/plain",
            ...(payload ? { "content-type": contentType ?? "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy(new KubeError(502, "The Kubernetes API response was too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) resolve(text);
            else reject(new KubeError(code, statusMessage(text, code)));
          });
          res.on("error", (err) => reject(new KubeError(502, `Kubernetes API response failed: ${err.message}`)));
        },
      );
      req.on("timeout", () => req.destroy(new KubeError(504, "Timed out talking to the Kubernetes API (is egress to the API server allowed by NetworkPolicy?)")));
      req.on("error", (err) =>
        reject(err instanceof KubeError ? err : new KubeError(503, `Cannot reach the Kubernetes API: ${err.message} (is egress to the API server allowed by NetworkPolicy?)`)),
      );
      req.end(payload);
    });

  return {
    getJson: async <T>(path: string) => JSON.parse(await request("GET", path)) as T,
    getText: (path) => request("GET", path),
    patchJson: async <T>(path: string, body: unknown, kind: "strategic" | "merge") => JSON.parse(await request("PATCH", path, body, PATCH_CONTENT_TYPE[kind])) as T,
  };
}
