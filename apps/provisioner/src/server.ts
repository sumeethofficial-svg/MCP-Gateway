import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Logger } from "pino";
import { z } from "zod";
import { KubeError } from "./kube.js";
import { StoreError, type StoreManager } from "./manager.js";

const createBody = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  ownerId: z.string().min(1).max(100),
  ownerEmail: z.string().max(200).optional(),
});

const digest = (s: string) => createHash("sha256").update(s).digest();

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function readBody(req: http.IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new StoreError(413, "too_large", "Request body is too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new StoreError(400, "invalid_json", "Request body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Internal API for the gateway. Every /stores route needs the shared bearer token. */
export function createApi(manager: StoreManager, token: string, log: Logger): http.Server {
  const expected = digest(token);
  const authorised = (req: http.IncomingMessage): boolean => {
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    return timingSafeEqual(digest(given), expected);
  };

  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean);
        const method = req.method ?? "GET";

        if (url.pathname === "/healthz" || url.pathname === "/readyz") return send(res, 200, { status: "ok" });
        if (parts[0] !== "stores") return send(res, 404, { error: { code: "not_found", message: "Not found" } });
        if (!authorised(req)) return send(res, 401, { error: { code: "unauthorized", message: "Authentication required" } });

        if (parts.length === 1 && method === "GET") {
          return send(res, 200, { stores: await manager.list(url.searchParams.get("owner") ?? undefined) });
        }
        if (parts.length === 1 && method === "POST") {
          const input = createBody.safeParse(await readBody(req));
          if (!input.success) throw new StoreError(400, "invalid_request", input.error.issues[0]?.message ?? "Invalid request");
          const { store, created } = await manager.create(input.data);
          return send(res, created ? 201 : 200, { store, created });
        }
        const id = parts[1] ?? "";
        if (parts.length === 2 && method === "GET") {
          const store = await manager.get(id);
          if (!store) throw new StoreError(404, "not_found", "Store not found");
          return send(res, 200, { store });
        }
        if (parts.length === 2 && method === "DELETE") return send(res, 202, { store: await manager.remove(id) });
        if (parts.length === 3 && parts[2] === "mcp" && method === "GET") return send(res, 200, await manager.mcpEndpoint(id));
        return send(res, 404, { error: { code: "not_found", message: "Not found" } });
      } catch (err) {
        if (err instanceof StoreError) return send(res, err.status, { error: { code: err.code, message: err.message } });
        if (err instanceof KubeError) {
          log.error({ status: err.status, err: err.message }, "kubernetes error");
          return send(res, 502, { error: { code: "kubernetes_error", message: "The Kubernetes API did not accept the request" } });
        }
        log.error({ err: (err as Error).message }, "unhandled error");
        return send(res, 500, { error: { code: "internal", message: "Something went wrong" } });
      }
    })();
  });
}
