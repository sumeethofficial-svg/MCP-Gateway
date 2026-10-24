import type { Principal } from "../auth/principal.js";
import type { Db } from "../db/pool.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { CatalogEntry } from "../upstreams/catalog.js";

export type Effect = "allow" | "deny";

export interface PolicyRule {
  id: string;
  subjectType: "role" | "user";
  subject: string;
  serverSlug: string;
  toolName: string;
  effect: Effect;
  createdAt: Date;
  createdByEmail: string | null;
}

export interface Decision {
  allowed: boolean;
  source: "rule" | "default";
  reason: string;
}

/**
 * Permission model
 * ----------------
 * A rule says: for <role | user>, on <server | *>, for <tool | *>, allow or deny.
 *
 * Resolution: among rules that match the caller and the tool, the most specific wins
 * (a user rule beats a role rule; a tool rule beats a server rule beats a wildcard).
 * At equal specificity, deny wins.
 *
 * With no matching rule:
 *   - admins may call any approved tool;
 *   - the owner of a store may call any approved tool of that store (and nobody else but admins may call it at all);
 *   - members may call a tool only if it is read-only AND its server is one whose
 *     annotations an admin has chosen to trust. Everything else is denied.
 *
 * The default is least privilege on purpose: a newly added server's write tools are
 * unavailable to members until an admin grants them.
 */
export function decide(principal: Pick<Principal, "userId" | "role">, entry: CatalogEntry, rules: PolicyRule[]): Decision {
  // A store's tools belong to the user who created the store. This comes before any rule, so a broad "allow" rule for
  // members can never expose one user's shop to another. Admins operate every store.
  const owner = entry.server.ownerId;
  const owns = !!owner && owner === principal.userId;
  if (owner && !owns && principal.role !== "admin") {
    return { allowed: false, source: "default", reason: "This store belongs to another user" };
  }

  const applicable = rules.filter((r) => {
    const subjectMatches = r.subjectType === "user" ? r.subject === principal.userId : r.subject === principal.role;
    const serverMatches = r.serverSlug === "*" || r.serverSlug === entry.server.slug;
    const toolMatches = r.toolName === "*" || r.toolName === entry.upstreamName;
    return subjectMatches && serverMatches && toolMatches;
  });

  if (applicable.length > 0) {
    const score = (r: PolicyRule) => (r.subjectType === "user" ? 100 : 0) + (r.toolName !== "*" ? 10 : r.serverSlug !== "*" ? 5 : 0);
    const best = Math.max(...applicable.map(score));
    const top = applicable.filter((r) => score(r) === best);
    const winner = top.find((r) => r.effect === "deny") ?? top[0]!;
    const scope = winner.toolName !== "*" ? `${winner.serverSlug}/${winner.toolName}` : winner.serverSlug !== "*" ? `server ${winner.serverSlug}` : "all tools";
    return {
      allowed: winner.effect === "allow",
      source: "rule",
      reason: `${winner.effect === "allow" ? "Allowed" : "Denied"} by a ${winner.subjectType} rule for ${scope}`,
    };
  }

  if (principal.role === "admin") return { allowed: true, source: "default", reason: "Admins may call any approved tool" };
  if (owns) return { allowed: true, source: "default", reason: "You own this store" };

  const readOnly = entry.annotations?.readOnlyHint === true;
  if (readOnly && entry.server.trustAnnotations) return { allowed: true, source: "default", reason: "Read-only tool" };
  return {
    allowed: false,
    source: "default",
    reason: readOnly
      ? `This server's read-only annotations are not trusted, so "${entry.upstreamName}" is restricted to admins`
      : `"${entry.upstreamName}" can change data, so it is restricted to admins unless a rule grants access`,
  };
}

interface RuleRow {
  id: string;
  subject_type: "role" | "user";
  subject: string;
  server_slug: string;
  tool_name: string;
  effect: Effect;
  created_at: Date;
  created_by_email: string | null;
}

const toRule = (r: RuleRow): PolicyRule => ({
  id: r.id,
  subjectType: r.subject_type,
  subject: r.subject,
  serverSlug: r.server_slug,
  toolName: r.tool_name,
  effect: r.effect,
  createdAt: r.created_at,
  createdByEmail: r.created_by_email,
});

export class PolicyStore {
  constructor(private readonly db: Db) {}

  async list(): Promise<PolicyRule[]> {
    const { rows } = await this.db.query<RuleRow>(
      `SELECT p.id, p.subject_type, p.subject, p.server_slug, p.tool_name, p.effect, p.created_at, u.email AS created_by_email
         FROM tool_policies p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.created_at`,
    );
    return rows.map(toRule);
  }

  /** Rules that can apply to this caller. Read per request (not cached) so changes take effect immediately. */
  async rulesFor(principal: Pick<Principal, "userId" | "role">): Promise<PolicyRule[]> {
    const { rows } = await this.db.query<RuleRow>(
      `SELECT id, subject_type, subject, server_slug, tool_name, effect, created_at, NULL::text AS created_by_email
         FROM tool_policies WHERE (subject_type = 'role' AND subject = $1) OR (subject_type = 'user' AND subject = $2)`,
      [principal.role, principal.userId],
    );
    return rows.map(toRule);
  }

  async create(input: { subjectType: "role" | "user"; subject: string; serverSlug: string; toolName: string; effect: Effect }, actorId: string): Promise<PolicyRule> {
    if (input.subjectType === "role" && input.subject !== "admin" && input.subject !== "member") throw badRequest("Role must be admin or member");
    if (input.toolName !== "*" && input.serverSlug === "*") throw badRequest("A rule for a specific tool must name its server");
    if (input.subjectType === "user") {
      const exists = await this.db.query("SELECT 1 FROM users WHERE id = $1", [input.subject]);
      if (!exists.rowCount) throw notFound("User not found");
    }
    if (input.serverSlug !== "*") {
      const exists = await this.db.query("SELECT 1 FROM upstream_servers WHERE slug = $1", [input.serverSlug]);
      if (!exists.rowCount) throw notFound("Server not found");
    }
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO tool_policies (subject_type, subject, server_slug, tool_name, effect, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (subject_type, subject, server_slug, tool_name) DO UPDATE SET effect = EXCLUDED.effect, created_by = EXCLUDED.created_by, created_at = now()
         RETURNING id`,
        [input.subjectType, input.subject, input.serverSlug, input.toolName, input.effect, actorId],
      );
      return (await this.list()).find((r) => r.id === rows[0]!.id)!;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw conflict("Rule already exists");
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    const res = await this.db.query("DELETE FROM tool_policies WHERE id = $1", [id]);
    if (!res.rowCount) throw notFound("Rule not found");
  }
}
