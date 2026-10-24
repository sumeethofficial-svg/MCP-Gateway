import type { Logger } from "pino";
import type { SeededUpstream } from "../config.js";
import type { SecretBox } from "../crypto.js";
import type { Db } from "../db/pool.js";
import { badRequest, conflict, notFound } from "../errors.js";

export type AuthType = "none" | "bearer" | "header";
export type HealthStatus = "unknown" | "connected" | "unreachable";
/** admin: added in the dashboard. helm: declared in chart values. provisioner: one per store, created and removed automatically. */
export type ManagedBy = "admin" | "helm" | "provisioner";

/** Everything the dashboard may see. Never includes the credential. */
export interface UpstreamRecord {
  id: string;
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeaderName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  trustAnnotations: boolean;
  managedBy: ManagedBy;
  /** For a store's server: the user who owns the store (others, except admins, cannot call its tools). */
  ownerId: string | null;
  storeId: string | null;
  version: number;
  status: HealthStatus;
  statusReason: string | null;
  lastCheckedAt: Date | null;
  lastLatencyMs: number | null;
  toolCount: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Server-side only: a record plus the decrypted credential, used to open connections. */
export interface ConnectableUpstream extends UpstreamRecord {
  credential: string | null;
}

export interface UpstreamInput {
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeaderName?: string | null;
  credential?: string | null;
  trustAnnotations?: boolean;
  enabled?: boolean;
}

export type UpstreamPatch = Partial<Omit<UpstreamInput, "slug">>;

/** Slugs the gateway reserves for its own synthetic tools. */
const RESERVED_SLUGS = new Set(["gateway", "mcp-portal", "admin"]);

/** Headers an admin must not be able to set, because they would corrupt or hijack the request. */
const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "content-type", "accept", "transfer-encoding", "connection", "upgrade", "te", "trailer",
  "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie", "set-cookie", "proxy-authorization", "x-forwarded-for", "x-forwarded-host",
]);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface Row {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: AuthType;
  auth_header_name: string | null;
  credential_enc: string | null;
  enabled: boolean;
  trust_annotations: boolean;
  managed_by: ManagedBy;
  owner_id: string | null;
  store_id: string | null;
  version: number;
  status: HealthStatus;
  status_reason: string | null;
  last_checked_at: Date | null;
  last_latency_ms: number | null;
  tool_count: number | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = "id, slug, name, url, auth_type, auth_header_name, credential_enc, enabled, trust_annotations, managed_by, owner_id, store_id, version, status, status_reason, last_checked_at, last_latency_ms, tool_count, created_at, updated_at";

function toRecord(r: Row): UpstreamRecord {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    url: r.url,
    authType: r.auth_type,
    authHeaderName: r.auth_header_name,
    hasCredential: r.credential_enc !== null,
    enabled: r.enabled,
    trustAnnotations: r.trust_annotations,
    managedBy: r.managed_by,
    ownerId: r.owner_id,
    storeId: r.store_id,
    version: r.version,
    status: r.status,
    statusReason: r.status_reason,
    lastCheckedAt: r.last_checked_at,
    lastLatencyMs: r.last_latency_ms,
    toolCount: r.tool_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Validates the slug/name/auth shape. URL safety (SSRF) is checked separately by the caller. */
function validateShape(input: { slug?: string; name?: string; authType: AuthType; authHeaderName?: string | null; credential?: string | null }, hasExistingCredential: boolean): void {
  if (input.slug !== undefined) {
    if (!SLUG.test(input.slug) || input.slug.length > 24) throw badRequest("Slug must be lowercase letters, digits and single hyphens, at most 24 characters", "invalid_slug");
    if (RESERVED_SLUGS.has(input.slug)) throw badRequest(`"${input.slug}" is reserved`, "invalid_slug");
  }
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 80)) throw badRequest("Name is required (max 80 characters)");
  if (input.authType === "header") {
    const header = input.authHeaderName ?? "";
    if (!HEADER_NAME.test(header)) throw badRequest("Header name may only contain letters, digits and hyphens", "invalid_header");
    if (FORBIDDEN_HEADERS.has(header.toLowerCase())) throw badRequest(`The header "${header}" cannot be used for credentials`, "invalid_header");
  }
  if (input.authType !== "none" && !input.credential && !hasExistingCredential) throw badRequest("A credential is required for this authentication type", "credential_required");
  if (input.credential && input.credential.length > 4096) throw badRequest("Credential is too long");
  if (input.credential && /[\r\n\0]/.test(input.credential)) throw badRequest("Credential must not contain control characters", "invalid_credential");
}

export class UpstreamRegistry {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly log: Logger,
  ) {}

  async list(): Promise<UpstreamRecord[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM upstream_servers ORDER BY created_at, slug`);
    return rows.map(toRecord);
  }

  async get(id: string): Promise<UpstreamRecord | undefined> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM upstream_servers WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  /** Enabled servers with decrypted credentials, for the connection pool. Never exposed over HTTP. */
  async listConnectable(opts: { onlyEnabled: boolean } = { onlyEnabled: true }): Promise<ConnectableUpstream[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM upstream_servers ${opts.onlyEnabled ? "WHERE enabled" : ""} ORDER BY created_at, slug`);
    return rows.map((r) => this.toConnectable(r));
  }

  async getConnectable(id: string): Promise<ConnectableUpstream | undefined> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM upstream_servers WHERE id = $1`, [id]);
    return rows[0] ? this.toConnectable(rows[0]) : undefined;
  }

  private toConnectable(r: Row): ConnectableUpstream {
    let credential: string | null = null;
    if (r.credential_enc) {
      try {
        credential = this.box.decrypt(r.credential_enc);
      } catch (err) {
        // A credential we cannot decrypt behaves like a missing one; the upstream will report 401.
        this.log.error({ slug: r.slug, err: (err as Error).message }, "cannot decrypt upstream credential");
      }
    }
    return { ...toRecord(r), credential };
  }

  async create(input: UpstreamInput, managedBy: ManagedBy = "admin", store?: { ownerId: string | null; storeId: string }): Promise<UpstreamRecord> {
    validateShape(input, false);
    try {
      const { rows } = await this.db.query<Row>(
        `INSERT INTO upstream_servers (slug, name, url, auth_type, auth_header_name, credential_enc, trust_annotations, enabled, managed_by, owner_id, store_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
        [
          input.slug,
          input.name.trim(),
          input.url,
          input.authType,
          input.authType === "header" ? input.authHeaderName : null,
          input.authType !== "none" && input.credential ? this.box.encrypt(input.credential) : null,
          input.trustAnnotations ?? false,
          input.enabled ?? true,
          managedBy,
          store?.ownerId ?? null,
          store?.storeId ?? null,
        ],
      );
      return toRecord(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw conflict(`A server with the slug "${input.slug}" already exists`, "slug_taken");
      throw err;
    }
  }

  async update(id: string, patch: UpstreamPatch): Promise<UpstreamRecord> {
    const current = await this.getConnectable(id);
    if (!current) throw notFound("Server not found");

    const authType = patch.authType ?? current.authType;
    const hasExisting = current.hasCredential && authType === current.authType;
    validateShape({ authType, authHeaderName: patch.authHeaderName ?? current.authHeaderName, credential: patch.credential, name: patch.name }, hasExisting);

    let credentialEnc: string | null | undefined;
    if (authType === "none") credentialEnc = null;
    else if (patch.credential) credentialEnc = this.box.encrypt(patch.credential);
    else if (authType !== current.authType) credentialEnc = null;
    // otherwise: credential omitted, keep the stored one

    const { rows } = await this.db.query<Row>(
      `UPDATE upstream_servers SET
         name = $2, url = $3, auth_type = $4, auth_header_name = $5,
         credential_enc = CASE WHEN $6::boolean THEN $7 ELSE credential_enc END,
         enabled = $8, trust_annotations = $9, version = version + 1, updated_at = now(),
         status = 'unknown', status_reason = NULL
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [
        id,
        (patch.name ?? current.name).trim(),
        patch.url ?? current.url,
        authType,
        authType === "header" ? (patch.authHeaderName ?? current.authHeaderName) : null,
        credentialEnc !== undefined,
        credentialEnc ?? null,
        patch.enabled ?? current.enabled,
        patch.trustAnnotations ?? current.trustAnnotations,
      ],
    );
    return toRecord(rows[0]!);
  }

  async setEnabled(id: string, enabled: boolean): Promise<UpstreamRecord> {
    const { rows } = await this.db.query<Row>(
      `UPDATE upstream_servers SET enabled = $2, version = version + 1, updated_at = now(),
              status = CASE WHEN $2 THEN 'unknown' ELSE status END
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, enabled],
    );
    if (!rows[0]) throw notFound("Server not found");
    return toRecord(rows[0]);
  }

  async remove(id: string): Promise<UpstreamRecord> {
    const server = await this.get(id);
    if (!server) throw notFound("Server not found");
    if (server.managedBy === "helm") {
      throw conflict("This server is managed by Helm values. Remove it there, or disable it here.", "managed_server");
    }
    if (server.managedBy === "provisioner") {
      throw conflict("This server belongs to a store. Delete the store to remove it.", "managed_server");
    }
    await this.db.query("DELETE FROM upstream_servers WHERE id = $1", [id]);
    return server;
  }

  /** Removes a store's server. Only the store sync calls this; the HTTP API cannot (see `remove`). */
  async removeStoreServer(id: string): Promise<void> {
    await this.db.query("DELETE FROM upstream_servers WHERE id = $1 AND managed_by = 'provisioner'", [id]);
  }

  async listStoreServers(): Promise<UpstreamRecord[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM upstream_servers WHERE managed_by = 'provisioner' ORDER BY created_at`);
    return rows.map(toRecord);
  }

  /** The tools-of-a-store upstream for one store id, with its decrypted credential (to detect rotation). */
  async getStoreServer(storeId: string): Promise<ConnectableUpstream | undefined> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM upstream_servers WHERE store_id = $1`, [storeId]);
    return rows[0] ? this.toConnectable(rows[0]) : undefined;
  }

  async getBySlug(slug: string): Promise<UpstreamRecord | undefined> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM upstream_servers WHERE slug = $1`, [slug]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async recordHealth(id: string, health: { status: HealthStatus; reason?: string | null; latencyMs?: number | null; toolCount?: number | null }): Promise<void> {
    await this.db.query(
      `UPDATE upstream_servers SET status = $2, status_reason = $3, last_latency_ms = $4, tool_count = COALESCE($5, tool_count), last_checked_at = now()
        WHERE id = $1 AND enabled`,
      [id, health.status, health.reason ?? null, health.latencyMs ?? null, health.toolCount ?? null],
    );
  }

  /**
   * Reconciles Helm-declared upstreams. URL, name and credential follow Helm on every start
   * (so rotating a Secret and restarting is enough). `enabled` is set only on first creation:
   * an admin who disabled a server in the dashboard keeps it disabled across restarts.
   */
  async seed(seeded: SeededUpstream[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
    for (const s of seeded) {
      const credential = s.credentialEnv ? env[s.credentialEnv] : undefined;
      if (s.credentialEnv && !credential) {
        this.log.warn({ slug: s.slug, credentialEnv: s.credentialEnv }, "seeded upstream references an unset credential variable");
      }
      const authType: AuthType = credential ? "bearer" : "none";
      const existing = (await this.list()).find((u) => u.slug === s.slug);
      if (!existing) {
        await this.create({ slug: s.slug, name: s.name, url: s.url, authType, credential, trustAnnotations: s.trustAnnotations, enabled: s.enabled }, "helm");
        this.log.info({ slug: s.slug }, "seeded upstream server");
        continue;
      }
      if (existing.managedBy !== "helm") continue; // never take over an admin-created server
      await this.update(existing.id, { name: s.name, url: s.url, authType, credential: credential ?? undefined, trustAnnotations: s.trustAnnotations });
    }
  }
}
