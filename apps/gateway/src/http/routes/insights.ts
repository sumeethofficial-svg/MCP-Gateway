import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../container.js";
import { me, parse, requireUser } from "../support.js";

const date = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export function insightRoutes(app: FastifyInstance, c: Container): void {
  const user = requireUser(c);

  // Admins see everyone's calls. Members see only their own: the audit log is also
  // a record of what other people asked, which is not theirs to browse.
  app.get("/api/audit", { preHandler: user }, async (req) => {
    const p = me(req);
    const q = parse(
      z.object({
        userId: z.string().uuid().optional(),
        server: z.string().max(24).optional(),
        tool: z.string().max(200).optional(),
        outcome: z.enum(["ok", "tool_error", "error", "timeout", "unavailable", "denied", "not_found", "rate_limited", "quarantined", "failed"]).optional(),
        from: date.optional(),
        to: date.optional(),
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    );
    const { rows, nextCursor } = await c.audit.query({ ...q, userId: p.role === "admin" ? q.userId : p.userId });
    return { rows, nextCursor };
  });

  app.get("/api/stats", { preHandler: user }, async (req) => {
    const p = me(req);
    const q = parse(z.object({ hours: z.coerce.number().int().min(1).max(720).default(24), scope: z.enum(["all", "me"]).optional() }), req.query);
    const mine = p.role !== "admin" || q.scope === "me";
    return c.audit.stats(q.hours, mine ? p.userId : undefined);
  });

  /** What the signed-in user's own MCP client will see: handy for the "Connect" page and onboarding. */
  app.get("/api/gateway", { preHandler: user }, async (req) => {
    const p = me(req);
    const { tools, unreachable } = await c.gateway.listVisibleTools(p);
    return {
      mcpUrl: `${c.config.publicUrl}/mcp`,
      lazyMcpUrl: `${c.config.publicUrl}/mcp/lazy`,
      toolCount: tools.length,
      lazyThreshold: c.config.lazyToolsThreshold,
      unreachable,
      tools: tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 160), readOnly: t.annotations?.readOnlyHint === true })),
    };
  });
}
