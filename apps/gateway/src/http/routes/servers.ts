import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../container.js";
import { notFound } from "../../errors.js";
import { decide } from "../../policy/engine.js";
import type { UpstreamRecord } from "../../upstreams/registry.js";
import { me, parse, requireAdmin, requireUser } from "../support.js";

const idParam = z.object({ id: z.string().uuid() });
const authType = z.enum(["none", "bearer", "header"]);

const serverFields = {
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().min(1).max(500),
  authType,
  authHeaderName: z.string().trim().max(64).nullable().optional(),
  credential: z.string().max(4096).nullable().optional(),
  trustAnnotations: z.boolean().optional(),
};
const createBody = z.object({ slug: z.string().trim().min(1).max(24), ...serverFields, enabled: z.boolean().optional() });
const patchBody = z.object({ ...serverFields, enabled: z.boolean().optional() }).partial();

/** Admin view of a server: everything except the credential, which never leaves the backend. */
function adminView(s: UpstreamRecord, quarantined = 0) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    url: s.url,
    authType: s.authType,
    authHeaderName: s.authHeaderName,
    hasCredential: s.hasCredential,
    enabled: s.enabled,
    trustAnnotations: s.trustAnnotations,
    managedBy: s.managedBy,
    ownerId: s.ownerId,
    storeId: s.storeId,
    status: s.enabled ? s.status : "disabled",
    statusReason: s.enabled ? s.statusReason : null,
    lastCheckedAt: s.lastCheckedAt,
    latencyMs: s.lastLatencyMs,
    toolCount: s.toolCount,
    quarantinedTools: quarantined,
    createdAt: s.createdAt,
  };
}

/** Member view: enough to know what exists and whether it is healthy. No URLs, no auth details. */
function memberView(s: UpstreamRecord) {
  return { id: s.id, slug: s.slug, name: s.name, enabled: s.enabled, status: s.enabled ? s.status : "disabled", toolCount: s.toolCount };
}

export function serverRoutes(app: FastifyInstance, c: Container): void {
  const user = requireUser(c);
  const admin = requireAdmin();

  app.get("/api/servers", { preHandler: user }, async (req) => {
    const isAdmin = me(req).role === "admin";
    const [servers, quarantined] = await Promise.all([c.registry.list(), isAdmin ? c.pins.quarantinedCounts() : Promise.resolve(new Map<string, number>())]);
    const mine = me(req).userId;
    // A store's server is listed only for its owner (and admins), so members never learn that other users' shops exist.
    const visible = isAdmin ? servers : servers.filter((s) => !s.ownerId || s.ownerId === mine);
    return { servers: visible.map((s) => (isAdmin ? adminView(s, quarantined.get(s.id) ?? 0) : memberView(s))) };
  });

  app.post("/api/servers/test", { preHandler: [user, admin] }, async (req) => {
    const body = parse(z.object({ url: serverFields.url, authType, authHeaderName: serverFields.authHeaderName, credential: serverFields.credential }), req.body);
    return c.admin.test(body);
  });

  app.post("/api/servers", { preHandler: [user, admin] }, async (req, reply) => {
    const body = parse(createBody, req.body);
    const created = await c.admin.create(body);
    void reply.status(201);
    return { server: adminView(created) };
  });

  app.patch("/api/servers/:id", { preHandler: [user, admin] }, async (req) => {
    const { id } = parse(idParam, req.params);
    const updated = await c.admin.update(id, parse(patchBody, req.body));
    return { server: adminView(updated, (await c.pins.quarantinedCounts()).get(id) ?? 0) };
  });

  app.delete("/api/servers/:id", { preHandler: [user, admin] }, async (req) => {
    await c.admin.remove(parse(idParam, req.params).id);
    return { ok: true };
  });

  app.post("/api/servers/:id/check", { preHandler: [user, admin] }, async (req) => {
    const { id } = parse(idParam, req.params);
    if (!(await c.registry.get(id))) throw notFound("Server not found");
    await c.health.check(id);
    return { server: adminView((await c.registry.get(id))!, (await c.pins.quarantinedCounts()).get(id) ?? 0) };
  });

  // Tools of one server. Admins see everything (including quarantined tools and who may call each);
  // members see only what they are allowed to call.
  app.get("/api/servers/:id/tools", { preHandler: user }, async (req) => {
    const principal = me(req);
    const { id } = parse(idParam, req.params);
    const server = await c.registry.getConnectable(id);
    if (!server || (server.ownerId && server.ownerId !== principal.userId && principal.role !== "admin")) throw notFound("Server not found");
    if (!server.enabled) return { server: { slug: server.slug, name: server.name }, enabled: false, reachable: false, tools: [] };

    const [snap, pins, allRules] = await Promise.all([c.catalog.refresh(server), c.pins.list(id), c.policy.list()]);
    const previous = new Map(pins.map((p) => [p.toolName, p.previousDescription]));
    const roleRules = allRules.filter((r) => r.subjectType === "role");
    const isAdmin = principal.role === "admin";
    const myRules = isAdmin ? [] : await c.policy.rulesFor(principal);

    const tools = snap.entries
      .map((e) => {
        const access = {
          admin: decide({ userId: "-", role: "admin" }, e, roleRules),
          member: decide({ userId: "-", role: "member" }, e, roleRules),
        };
        return {
          name: e.upstreamName,
          exposedName: e.exposedName,
          title: e.title ?? null,
          description: e.description,
          annotations: { readOnlyHint: e.annotations?.readOnlyHint ?? null, destructiveHint: e.annotations?.destructiveHint ?? null },
          inputSchema: e.inputSchema,
          pin: { status: e.pin.status, flags: e.pin.flags, reason: e.pin.reason, defHash: e.pin.defHash, previousDescription: previous.get(e.upstreamName) ?? null },
          access,
          mine: decide(principal, e, isAdmin ? [] : myRules),
        };
      })
      .filter((t) => isAdmin || (t.pin.status === "approved" && t.mine.allowed));

    return {
      server: { slug: server.slug, name: server.name },
      enabled: true,
      reachable: snap.ok,
      stale: snap.stale,
      error: snap.error?.message ?? null,
      tools: isAdmin ? tools : tools.map(({ inputSchema, pin, access, ...rest }) => ({ ...rest, pin: { status: pin.status }, inputSchema })),
    };
  });

  app.post("/api/servers/:id/tools/:name/review", { preHandler: [user, admin] }, async (req) => {
    const params = parse(idParam.extend({ name: z.string().min(1).max(200) }), req.params);
    const body = parse(z.object({ decision: z.enum(["approved", "rejected"]), defHash: z.string().length(64) }), req.body);
    const pin = await c.pins.review(params.id, params.name, body.decision, body.defHash, me(req).userId);
    c.catalog.invalidate(params.id);
    return { pin: { toolName: pin.toolName, status: pin.status, reason: pin.reason } };
  });

  // ---- tool permissions ----------------------------------------------------
  app.get("/api/policies", { preHandler: [user, admin] }, async () => ({ rules: await c.policy.list() }));

  app.post("/api/policies", { preHandler: [user, admin] }, async (req, reply) => {
    const body = parse(
      z.object({
        subjectType: z.enum(["role", "user"]),
        subject: z.string().min(1).max(100),
        serverSlug: z.string().min(1).max(24).default("*"),
        toolName: z.string().min(1).max(200).default("*"),
        effect: z.enum(["allow", "deny"]),
      }),
      req.body,
    );
    void reply.status(201);
    return { rule: await c.policy.create(body, me(req).userId) };
  });

  app.delete("/api/policies/:id", { preHandler: [user, admin] }, async (req) => {
    await c.policy.remove(parse(idParam, req.params).id);
    return { ok: true };
  });
}
