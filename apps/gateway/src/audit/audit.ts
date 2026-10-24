import type { Principal } from "../auth/principal.js";
import type { Db } from "../db/pool.js";

export type Outcome = "ok" | "tool_error" | "error" | "timeout" | "unavailable" | "denied" | "not_found" | "rate_limited" | "quarantined";

export interface AuditEvent {
  requestId?: string;
  principal: Principal;
  clientName?: string;
  serverSlug?: string;
  toolName?: string;
  exposedName?: string;
  outcome: Outcome;
  errorMessage?: string;
  durationMs: number;
  args?: unknown;
}

export interface AuditRow {
  id: number;
  ts: Date;
  requestId: string | null;
  userId: string | null;
  userEmail: string | null;
  via: "api_key" | "chat";
  keyPrefix: string | null;
  clientName: string | null;
  serverSlug: string | null;
  toolName: string | null;
  exposedName: string | null;
  outcome: Outcome;
  errorMessage: string | null;
  durationMs: number;
  argsPreview: string | null;
}

export interface AuditFilter {
  userId?: string;
  server?: string;
  tool?: string;
  outcome?: Outcome | "failed";
  from?: Date;
  to?: Date;
  /** Cursor: only rows with id lower than this (rows are returned newest first). */
  before?: number;
  limit?: number;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[_-]?key|credential|cookie/i;

/** Compact, redacted rendering of tool arguments for the audit trail. Never stores secrets. */
export function previewArgs(args: unknown, maxLength = 500): string | undefined {
  if (args === undefined || args === null) return undefined;
  const redact = (value: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k, redact(v, k)]));
    if (typeof value === "string" && value.length > 200) return `${value.slice(0, 200)}…`;
    return value;
  };
  const text = JSON.stringify(redact(args));
  if (text === "{}") return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export class AuditService {
  constructor(private readonly db: Db) {}

  async record(event: AuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (request_id, user_id, user_email, via, key_prefix, client_name, server_slug, tool_name, exposed_name, outcome, error_message, duration_ms, args_preview)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        event.requestId ?? null,
        event.principal.userId,
        event.principal.email,
        event.principal.via,
        event.principal.keyPrefix ?? null,
        event.clientName?.slice(0, 80) ?? null,
        event.serverSlug ?? null,
        event.toolName?.slice(0, 200) ?? null,
        event.exposedName?.slice(0, 200) ?? null,
        event.outcome,
        event.errorMessage?.slice(0, 500) ?? null,
        Math.max(0, Math.round(event.durationMs)),
        previewArgs(event.args) ?? null,
      ],
    );
  }

  async query(filter: AuditFilter): Promise<{ rows: AuditRow[]; nextCursor: number | null }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.userId) add("user_id = ?", filter.userId);
    if (filter.server) add("server_slug = ?", filter.server);
    if (filter.tool) {
      params.push(filter.tool);
      where.push(`(tool_name = $${params.length} OR exposed_name = $${params.length})`);
    }
    if (filter.outcome === "failed") where.push("outcome <> 'ok'");
    else if (filter.outcome) add("outcome = ?", filter.outcome);
    if (filter.from) add("ts >= ?", filter.from);
    if (filter.to) add("ts < ?", filter.to);
    if (filter.before) add("id < ?", filter.before);

    params.push(limit + 1);
    const { rows } = await this.db.query(
      `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit).map(
      (r): AuditRow => ({
        id: Number(r.id),
        ts: r.ts,
        requestId: r.request_id,
        userId: r.user_id,
        userEmail: r.user_email,
        via: r.via,
        keyPrefix: r.key_prefix,
        clientName: r.client_name,
        serverSlug: r.server_slug,
        toolName: r.tool_name,
        exposedName: r.exposed_name,
        outcome: r.outcome,
        errorMessage: r.error_message,
        durationMs: r.duration_ms,
        argsPreview: r.args_preview,
      }),
    );
    return { rows: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  /** Aggregates for the overview dashboard. Scoped to one user when `userId` is given. */
  async stats(hours: number, userId?: string) {
    const window = Math.min(Math.max(hours, 1), 24 * 30);
    const since = new Date(Date.now() - window * 3_600_000);
    const bucket = window <= 6 ? "10 minutes" : window <= 48 ? "1 hour" : "1 day";
    const scope = userId ? "AND user_id = $2" : "";
    const params = userId ? [since, userId] : [since];

    const [totals, perServer, series, topTools, users] = await Promise.all([
      this.db.query(
        `SELECT count(*)::int AS calls, count(*) FILTER (WHERE outcome <> 'ok')::int AS failures,
                coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50,
                coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95
           FROM audit_log WHERE ts >= $1 ${scope}`,
        params,
      ),
      this.db.query(
        `SELECT coalesce(server_slug, '(none)') AS server, count(*)::int AS calls, count(*) FILTER (WHERE outcome <> 'ok')::int AS failures,
                coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95
           FROM audit_log WHERE ts >= $1 ${scope} GROUP BY 1 ORDER BY calls DESC`,
        params,
      ),
      this.db.query(
        `SELECT date_bin('${bucket}', ts, TIMESTAMPTZ '2000-01-01') AS bucket, count(*) FILTER (WHERE outcome = 'ok')::int AS ok, count(*) FILTER (WHERE outcome <> 'ok')::int AS failed
           FROM audit_log WHERE ts >= $1 ${scope} GROUP BY 1 ORDER BY 1`,
        params,
      ),
      this.db.query(
        `SELECT coalesce(exposed_name, tool_name, '(unknown)') AS tool, count(*)::int AS calls
           FROM audit_log WHERE ts >= $1 ${scope} GROUP BY 1 ORDER BY calls DESC LIMIT 5`,
        params,
      ),
      this.db.query(`SELECT count(DISTINCT user_id)::int AS users FROM audit_log WHERE ts >= $1 ${scope}`, params),
    ]);

    return {
      windowHours: window,
      bucket,
      totals: totals.rows[0] as { calls: number; failures: number; p50: number; p95: number },
      activeUsers: (users.rows[0] as { users: number }).users,
      perServer: perServer.rows as { server: string; calls: number; failures: number; p95: number }[],
      series: series.rows.map((r) => ({ bucket: r.bucket as Date, ok: r.ok as number, failed: r.failed as number })),
      topTools: topTools.rows as { tool: string; calls: number }[],
    };
  }
}
