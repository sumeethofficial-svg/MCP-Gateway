import cookie from "@fastify/cookie";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Container } from "../container.js";
import { AppError } from "../errors.js";
import { authRoutes } from "./routes/auth.js";
import { insightRoutes } from "./routes/insights.js";
import { mcpRoutes } from "./routes/mcp.js";
import { serverRoutes } from "./routes/servers.js";
import { storeRoutes } from "./routes/stores.js";
import { teamRoutes } from "./routes/team.js";
import { chatRoutes } from "./routes/chat.js";
import { zodToBadRequest } from "./support.js";

/** Custom header every dashboard request must carry; a cross-site form post cannot set it. */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "mcp-portal";

const QUIET_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

export async function buildApp(c: Container, opts: { llmFetch?: typeof fetch } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 1_048_576,
    genReqId: () => crypto.randomUUID(),
  });
  await app.register(cookie);
  const publicHost = new URL(c.config.publicUrl).host;

  // CSRF defence for cookie-authenticated routes: SameSite=Lax on the cookie, plus a required
  // custom header and an Origin check on every state-changing /api request.
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (req.headers[CSRF_HEADER] !== CSRF_VALUE) throw new AppError(403, "csrf", "Missing CSRF header");
    const origin = req.headers.origin;
    if (origin) {
      let host: string | undefined;
      try {
        host = new URL(origin).host;
      } catch {
        /* falls through to rejection */
      }
      // Accept the host the request arrived on (honouring X-Forwarded-Host from the Ingress)
      // or the configured public URL. Anything else is a cross-site request.
      if (host !== req.host && host !== publicHost) throw new AppError(403, "csrf", "Cross-origin request rejected");
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (QUIET_PATHS.has(path)) return;
    c.log.info(
      { reqId: req.id, method: req.method, path, status: reply.statusCode, ms: Math.round(reply.elapsedTime), user: req.principal?.userId },
      "request",
    );
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (reply.sent) return;
    if (err instanceof ZodError) err = zodToBadRequest(err);
    if (err instanceof AppError) {
      const retryAfterMs = (err as AppError & { retryAfterMs?: number }).retryAfterMs;
      if (retryAfterMs) void reply.header("retry-after", Math.ceil(retryAfterMs / 1000));
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, retryAfterMs } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: (err as FastifyError).code ?? "bad_request", message: err.message } });
    }
    c.log.error({ err: err.message, stack: err.stack, reqId: req.id }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong on our side." } });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "Not found" } }));

  // ---- system endpoints (cluster-internal; the Ingress does not route /metrics) ----
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await c.db.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "database_unavailable" });
    }
  });
  app.get("/metrics", async (_req, reply) => {
    void reply.type(c.metrics.registry.contentType);
    return c.metrics.registry.metrics();
  });

  authRoutes(app, c);
  teamRoutes(app, c);
  serverRoutes(app, c);
  storeRoutes(app, c);
  insightRoutes(app, c);
  chatRoutes(app, c, opts.llmFetch);
  mcpRoutes(app, c);
  return app;
}
