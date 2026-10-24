import type { FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { Principal } from "../auth/principal.js";
import type { Container } from "../container.js";
import { badRequest, forbidden, unauthorized } from "../errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireUser` for cookie-authenticated dashboard requests. */
    principal?: Principal;
  }
}

export const SESSION_COOKIE = "sg_session";

/** Parses with zod and converts failures into a 400 whose message names the offending field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  throw zodToBadRequest(result.error);
}

export function zodToBadRequest(err: ZodError) {
  const issue = err.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return badRequest(`${where}${issue?.message ?? "Invalid request"}`, "validation_error");
}

export function sessionToken(req: FastifyRequest): string | undefined {
  const value = req.cookies?.[SESSION_COOKIE];
  return value && value.length > 10 ? value : undefined;
}

/** preHandler: requires a valid dashboard session. */
export function requireUser(c: Container) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = sessionToken(req);
    const principal = token ? await c.auth.resolveSession(token) : undefined;
    if (!principal) throw unauthorized();
    req.principal = principal;
  };
}

/** preHandler (after requireUser): requires the admin role. */
export function requireAdmin() {
  return async (req: FastifyRequest): Promise<void> => {
    if (req.principal?.role !== "admin") throw forbidden("This action requires an administrator");
  };
}

export function me(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

export function setSessionCookie(c: Container, reply: FastifyReply, token: string, expiresAt: Date): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: c.config.cookieSecure,
    path: "/",
    expires: expiresAt,
  });
}

export function publicUser(u: { id: string; email: string; name: string; role: string }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}
