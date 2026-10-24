import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { sha256Hex } from "../crypto.js";
import { withTransaction, type Db } from "../db/pool.js";
import { conflict, notFound } from "../errors.js";
import { describeFindings, scanTool } from "./scanner.js";

export type PinStatus = "approved" | "quarantined" | "rejected";

export interface PinRecord {
  serverId: string;
  toolName: string;
  defHash: string;
  status: PinStatus;
  reason: string | null;
  description: string | null;
  previousDescription: string | null;
  flags: string[];
  firstSeenAt: Date;
  changedAt: Date;
  reviewedAt: Date | null;
}

interface PinRow {
  server_id: string;
  tool_name: string;
  def_hash: string;
  status: PinStatus;
  reason: string | null;
  description: string | null;
  previous_description: string | null;
  flags: string[];
  first_seen_at: Date;
  changed_at: Date;
  reviewed_at: Date | null;
}

const toPin = (r: PinRow): PinRecord => ({
  serverId: r.server_id,
  toolName: r.tool_name,
  defHash: r.def_hash,
  status: r.status,
  reason: r.reason,
  description: r.description,
  previousDescription: r.previous_description,
  flags: r.flags,
  firstSeenAt: r.first_seen_at,
  changedAt: r.changed_at,
  reviewedAt: r.reviewed_at,
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Hash of everything that influences how a model or the policy engine treats a tool.
 * Annotations are included deliberately: flipping readOnlyHint to true is a privilege
 * escalation, so it must count as a definition change.
 */
export function definitionHash(tool: Tool): string {
  return sha256Hex(stableStringify({ name: tool.name, title: tool.title ?? null, description: tool.description ?? null, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null, annotations: tool.annotations ?? null }));
}

const trunc = (s: string | undefined, n = 4000) => (s ? s.slice(0, n) : null);

/**
 * Trust-on-first-use pinning of tool definitions.
 *
 *   first seen, clean   -> approved
 *   first seen, flagged -> quarantined (scanner found manipulation patterns)
 *   approved, changed   -> quarantined ("rug pull" protection; needs re-approval)
 *
 * Only approved tools are visible to clients, the chat agent, and the policy engine.
 */
export class PinStore {
  constructor(private readonly db: Db) {}

  /**
   * @param operatorVetted true for servers declared in Helm values. Their tools are approved on
   *   first sight even if the scanner has warnings (the operator vouched for the server); the
   *   warnings are kept for the admin to see. Later changes are quarantined for every server.
   */
  async sync(serverId: string, tools: Tool[], operatorVetted = false): Promise<Map<string, PinRecord>> {
    return withTransaction(this.db, async (tx) => {
      const { rows } = await tx.query<PinRow>("SELECT * FROM tool_pins WHERE server_id = $1 FOR UPDATE", [serverId]);
      const existing = new Map(rows.map((r) => [r.tool_name, r]));

      for (const tool of tools) {
        const hash = definitionHash(tool);
        const findings = scanTool(tool);
        const flags = findings.map((f) => f.id);
        const current = existing.get(tool.name);

        if (!current) {
          const status: PinStatus = findings.length && !operatorVetted ? "quarantined" : "approved";
          const reason = !findings.length
            ? "First seen"
            : operatorVetted
              ? `First seen on an operator-declared server. Scanner warnings: ${describeFindings(findings)}`
              : `Flagged on first sight: ${describeFindings(findings)}`;
          await tx.query(
            `INSERT INTO tool_pins (server_id, tool_name, def_hash, status, reason, description, flags)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (server_id, tool_name) DO NOTHING`,
            [serverId, tool.name, hash, status, reason, trunc(tool.description), flags],
          );
          continue;
        }
        if (current.def_hash === hash) continue;

        if (current.status === "approved") {
          const why = findings.length ? `Definition changed after approval and is now flagged: ${describeFindings(findings)}` : "Definition changed after approval";
          await tx.query(
            `UPDATE tool_pins SET def_hash = $3, status = 'quarantined', reason = $4, previous_description = description,
                    description = $5, flags = $6, changed_at = now(), reviewed_by = NULL, reviewed_at = NULL
              WHERE server_id = $1 AND tool_name = $2`,
            [serverId, tool.name, hash, why, trunc(tool.description), flags],
          );
        } else {
          // Already quarantined or rejected: track the latest definition, keep the decision state.
          await tx.query("UPDATE tool_pins SET def_hash = $3, description = $4, flags = $5, changed_at = now() WHERE server_id = $1 AND tool_name = $2", [
            serverId, tool.name, hash, trunc(tool.description), flags,
          ]);
        }
      }

      const after = await tx.query<PinRow>("SELECT * FROM tool_pins WHERE server_id = $1", [serverId]);
      return new Map(after.rows.map((r) => [r.tool_name, toPin(r)]));
    });
  }

  async list(serverId: string): Promise<PinRecord[]> {
    const { rows } = await this.db.query<PinRow>("SELECT * FROM tool_pins WHERE server_id = $1 ORDER BY tool_name", [serverId]);
    return rows.map(toPin);
  }

  /** Counts tools awaiting review, per server. Drives the dashboard badge. */
  async quarantinedCounts(): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ server_id: string; count: string }>("SELECT server_id, count(*) FROM tool_pins WHERE status = 'quarantined' GROUP BY server_id");
    return new Map(rows.map((r) => [r.server_id, Number(r.count)]));
  }

  /**
   * Records an admin's decision. The caller must present the hash they reviewed: if the
   * upstream changed the definition again in the meantime, the decision is refused.
   */
  async review(serverId: string, toolName: string, decision: "approved" | "rejected", reviewedHash: string, adminId: string): Promise<PinRecord> {
    const { rows } = await this.db.query<PinRow>("SELECT * FROM tool_pins WHERE server_id = $1 AND tool_name = $2", [serverId, toolName]);
    const pin = rows[0];
    if (!pin) throw notFound("Tool not found");
    if (pin.def_hash !== reviewedHash) throw conflict("The tool definition changed again while you were reviewing it. Review the new version.", "stale_review");

    const updated = await this.db.query<PinRow>(
      `UPDATE tool_pins SET status = $3, reviewed_by = $4, reviewed_at = now(),
              reason = CASE WHEN $3 = 'approved' THEN 'Approved by admin' ELSE 'Rejected by admin' END,
              previous_description = CASE WHEN $3 = 'approved' THEN NULL ELSE previous_description END
        WHERE server_id = $1 AND tool_name = $2 RETURNING *`,
      [serverId, toolName, decision, adminId],
    );
    return toPin(updated.rows[0]!);
  }
}
