import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../container.js";
import { me, parse, requireAdmin, requireUser } from "../support.js";

const role = z.enum(["admin", "member"]);
const idParam = z.object({ id: z.string().uuid() });

export function teamRoutes(app: FastifyInstance, c: Container): void {
  const user = requireUser(c);
  const admin = requireAdmin();

  // ---- members -------------------------------------------------------------
  app.get("/api/users", { preHandler: [user, admin] }, async () => {
    const users = await c.auth.listUsers();
    return { users: users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabledAt, createdAt: u.createdAt, activeKeys: u.activeKeys })) };
  });

  app.patch("/api/users/:id", { preHandler: [user, admin] }, async (req) => {
    const { id } = parse(idParam, req.params);
    const patch = parse(z.object({ role: role.optional(), disabled: z.boolean().optional() }).refine((v) => v.role !== undefined || v.disabled !== undefined, "Nothing to change"), req.body);
    const updated = await c.auth.updateUser(me(req), id, patch);
    return { user: { id: updated.id, email: updated.email, name: updated.name, role: updated.role, disabled: !!updated.disabledAt } };
  });

  // ---- invites -------------------------------------------------------------
  app.get("/api/invites", { preHandler: [user, admin] }, async () => ({ invites: await c.auth.listInvites() }));

  app.post("/api/invites", { preHandler: [user, admin] }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email().max(200), role: role.default("member") }), req.body);
    const { token, invite } = await c.auth.createInvite(me(req), body.email, body.role);
    void reply.header("cache-control", "no-store");
    // The link is shown once. Only its hash is stored.
    return { invite, inviteUrl: `${c.config.publicUrl}/accept-invite?token=${encodeURIComponent(token)}` };
  });

  app.delete("/api/invites/:id", { preHandler: [user, admin] }, async (req) => {
    await c.auth.revokeInvite(parse(idParam, req.params).id);
    return { ok: true };
  });

  // ---- API keys ------------------------------------------------------------
  app.get("/api/keys", { preHandler: user }, async (req) => {
    const p = me(req);
    const all = p.role === "admin" && parse(z.object({ scope: z.string().optional() }), req.query).scope === "all";
    const keys = await c.auth.listApiKeys(all ? {} : { userId: p.userId });
    return { keys };
  });

  app.post("/api/keys", { preHandler: user }, async (req, reply) => {
    const p = me(req);
    const body = parse(z.object({ name: z.string().min(1).max(60), expiresInDays: z.number().int().min(1).max(730).optional(), userId: z.string().uuid().optional() }), req.body);
    const { plaintext, key } = await c.auth.createApiKey(p, body.userId ?? p.userId, { name: body.name, expiresInDays: body.expiresInDays });
    void reply.header("cache-control", "no-store");
    // `plaintext` is returned exactly once and is not recoverable afterwards.
    return { key, plaintext };
  });

  app.delete("/api/keys/:id", { preHandler: user }, async (req) => {
    await c.auth.revokeApiKey(me(req), parse(idParam, req.params).id);
    return { ok: true };
  });
}
