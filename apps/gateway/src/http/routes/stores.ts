import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../container.js";
import { AppError } from "../../errors.js";
import { me, parse, requireUser } from "../support.js";

const idParam = z.object({ id: z.string().min(1).max(40) });
const createBody = z.object({
  name: z.string().trim().min(1).max(60),
  /** Optional idempotency key. Send the same id when retrying a create so it can never produce a second store. */
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9]([a-z0-9-]{0,16}[a-z0-9])?$/, "Store id must be 1-18 lowercase letters, digits or hyphens")
    .optional(),
});

/** Multi-store provisioning. Owners manage their own stores; admins manage all of them. */
export function storeRoutes(app: FastifyInstance, c: Container): void {
  const user = requireUser(c);
  const service = () => {
    if (!c.stores) throw new AppError(404, "stores_disabled", "Multi-store provisioning is not enabled on this deployment");
    return c.stores;
  };

  app.get("/api/stores", { preHandler: user }, async (req) => {
    if (!c.stores) return { enabled: false, stores: [] };
    return { enabled: true, stores: await c.stores.list(me(req)) };
  });

  app.post("/api/stores", { preHandler: user }, async (req, reply) => {
    const { store, created } = await service().create(me(req), parse(createBody, req.body));
    void reply.status(created ? 201 : 200);
    return { store, created };
  });

  app.get("/api/stores/:id", { preHandler: user }, async (req) => ({ store: await service().get(me(req), parse(idParam, req.params).id) }));

  app.delete("/api/stores/:id", { preHandler: user }, async (req, reply) => {
    const store = await service().remove(me(req), parse(idParam, req.params).id);
    void reply.status(202);
    return { store };
  });
}
