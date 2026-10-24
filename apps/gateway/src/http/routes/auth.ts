import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../container.js";
import { tooMany, unauthorized } from "../../errors.js";
import { me, parse, publicUser, requireUser, SESSION_COOKIE, sessionToken, setSessionCookie } from "../support.js";

const loginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
const acceptBody = z.object({ token: z.string().min(10).max(200), name: z.string().min(1).max(80), password: z.string().min(1).max(200) });

export function authRoutes(app: FastifyInstance, c: Container): void {
  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(loginBody, req.body);
    // Throttle per client address and per account, so neither a single IP nor a
    // distributed attempt against one mailbox gets unlimited guesses.
    const keys = [`ip:${req.ip}`, `acct:${body.email.toLowerCase()}`];
    for (const key of keys) {
      const decision = c.loginLimiter.consume(key);
      if (!decision.allowed) {
        c.metrics.authFailures.inc({ reason: "login_throttled" });
        throw tooMany("Too many sign-in attempts. Try again in a few minutes.", decision.retryAfterMs);
      }
    }
    try {
      const session = await c.auth.login(body.email, body.password, req.headers["user-agent"]);
      keys.forEach((k) => c.loginLimiter.reset(k));
      setSessionCookie(c, reply, session.token, session.expiresAt);
      return { user: publicUser(session.user) };
    } catch (err) {
      c.metrics.authFailures.inc({ reason: "login_invalid" });
      throw err;
    }
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = sessionToken(req);
    if (token) await c.auth.logout(token);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireUser(c) }, async (req) => {
    const p = me(req);
    return { user: publicUser({ id: p.userId, email: p.email, name: p.name, role: p.role }), gateway: { mcpUrl: `${c.config.publicUrl}/mcp`, lazyMcpUrl: `${c.config.publicUrl}/mcp/lazy` } };
  });

  // Invite acceptance is the one public write: the token is the credential.
  app.get("/api/invites/preview", async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.query);
    return c.auth.previewInvite(token);
  });

  app.post("/api/invites/accept", async (req, reply) => {
    const body = parse(acceptBody, req.body);
    const user = await c.auth.acceptInvite(body.token, { name: body.name, password: body.password });
    const session = await c.auth.login(user.email, body.password, req.headers["user-agent"]).catch(() => {
      throw unauthorized("Account created, but sign-in failed. Please sign in manually.");
    });
    setSessionCookie(c, reply, session.token, session.expiresAt);
    return { user: publicUser(user) };
  });
}
