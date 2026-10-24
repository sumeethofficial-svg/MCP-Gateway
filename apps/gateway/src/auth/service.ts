import type { Logger } from "pino";
import { DUMMY_PASSWORD_HASH, generateApiKey, hashPassword, parseApiKey, randomToken, safeEqualHex, sha256Hex, verifyPassword } from "../crypto.js";
import { withTransaction, type Db } from "../db/pool.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import type { Principal, Role, UserRecord } from "./principal.js";

const MIN_PASSWORD_LENGTH = 12;
const MAX_ACTIVE_KEYS_PER_USER = 10;
const INVITE_TTL_MS = 7 * 24 * 3_600_000;

export interface ApiKeyRecord {
  id: string;
  userId: string;
  userEmail: string;
  name: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface InviteRecord {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  invitedByEmail: string | null;
}

export type KeyAuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: "malformed" | "unknown" }
  /** The key was genuine but is no longer usable. `owner` lets the rejection be audited against the right user. */
  | { ok: false; reason: "revoked" | "expired" | "user_disabled"; owner: Principal };

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled_at: Date | null;
  created_at: Date;
}

const toUser = (r: UserRow): UserRecord => ({ id: r.id, email: r.email, name: r.name, role: r.role, disabledAt: r.disabled_at, createdAt: r.created_at });
const USER_COLUMNS = "id, email, name, role, disabled_at, created_at";
const normaliseEmail = (email: string) => email.trim().toLowerCase();

function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, "weak_password");
  if (password.length > 200) throw badRequest("Password is too long", "weak_password");
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly sessionTtlMs: number,
  ) {}

  // ---- Users ----------------------------------------------------------------

  /** Creates the first admin from deployment secrets. A no-op once any user exists. */
  async bootstrapAdmin(email: string, password: string): Promise<boolean> {
    const { rows } = await this.db.query<{ count: string }>("SELECT count(*) FROM users");
    if (Number(rows[0]?.count) > 0) return false;
    assertPassword(password);
    const hash = await hashPassword(password);
    await this.db.query("INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Administrator', 'admin', $2) ON CONFLICT DO NOTHING", [
      normaliseEmail(email),
      hash,
    ]);
    this.log.info({ email: normaliseEmail(email) }, "bootstrapped first admin");
    return true;
  }

  async listUsers(): Promise<(UserRecord & { activeKeys: number })[]> {
    const { rows } = await this.db.query<UserRow & { active_keys: string }>(
      `SELECT u.id, u.email, u.name, u.role, u.disabled_at, u.created_at,
              (SELECT count(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())) AS active_keys
         FROM users u ORDER BY u.created_at`,
    );
    return rows.map((r) => ({ ...toUser(r), activeKeys: Number(r.active_keys) }));
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const { rows } = await this.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async updateUser(actor: Principal, id: string, patch: { role?: Role; disabled?: boolean }): Promise<UserRecord> {
    return withTransaction(this.db, async (tx) => {
      const { rows } = await tx.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
      const target = rows[0];
      if (!target) throw notFound("User not found");

      const losesAdmin = target.role === "admin" && !target.disabled_at && (patch.role === "member" || patch.disabled === true);
      if (losesAdmin) {
        if (target.id === actor.userId) throw conflict("You cannot demote or disable your own account", "self_lockout");
        const { rows: admins } = await tx.query<{ count: string }>("SELECT count(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL");
        if (Number(admins[0]?.count) <= 1) throw conflict("This is the last active admin", "last_admin");
      }

      const role = patch.role ?? target.role;
      const disabledAt = patch.disabled === undefined ? target.disabled_at : patch.disabled ? (target.disabled_at ?? new Date()) : null;
      const updated = await tx.query<UserRow>(`UPDATE users SET role = $2, disabled_at = $3 WHERE id = $1 RETURNING ${USER_COLUMNS}`, [id, role, disabledAt]);
      if (patch.disabled === true) await tx.query("DELETE FROM sessions WHERE user_id = $1", [id]);
      return toUser(updated.rows[0]!);
    });
  }

  // ---- Invites --------------------------------------------------------------

  async createInvite(actor: Principal, email: string, role: Role): Promise<{ token: string; invite: InviteRecord }> {
    const normalised = normaliseEmail(email);
    const existing = await this.db.query("SELECT 1 FROM users WHERE lower(email) = $1", [normalised]);
    if (existing.rowCount) throw conflict("A user with this email already exists", "user_exists");

    // Replace any outstanding invite for the same address so only one link is ever live.
    await this.db.query("UPDATE invites SET revoked_at = now() WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [normalised]);

    const token = randomToken(32);
    const { rows } = await this.db.query<{ id: string }>(
      "INSERT INTO invites (email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [normalised, role, sha256Hex(token), actor.userId, new Date(Date.now() + INVITE_TTL_MS)],
    );
    const invite = (await this.listInvites()).find((i) => i.id === rows[0]!.id)!;
    return { token, invite };
  }

  async listInvites(): Promise<InviteRecord[]> {
    const { rows } = await this.db.query(
      `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, u.email AS invited_by_email
         FROM invites i LEFT JOIN users u ON u.id = i.invited_by ORDER BY i.created_at DESC LIMIT 100`,
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      expiresAt: r.expires_at,
      acceptedAt: r.accepted_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
      invitedByEmail: r.invited_by_email,
    }));
  }

  async revokeInvite(id: string): Promise<void> {
    const res = await this.db.query("UPDATE invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [id]);
    if (!res.rowCount) throw notFound("Invite not found or already used");
  }

  async previewInvite(token: string): Promise<{ email: string; role: Role }> {
    const invite = await this.findOpenInvite(this.db, token);
    return { email: invite.email, role: invite.role };
  }

  async acceptInvite(token: string, input: { name: string; password: string }): Promise<UserRecord> {
    assertPassword(input.password);
    const name = input.name.trim();
    if (!name || name.length > 80) throw badRequest("Name is required (max 80 characters)");
    const hash = await hashPassword(input.password);

    return withTransaction(this.db, async (tx) => {
      const invite = await this.findOpenInvite(tx, token, true);
      const exists = await tx.query("SELECT 1 FROM users WHERE lower(email) = $1", [invite.email]);
      if (exists.rowCount) throw conflict("A user with this email already exists", "user_exists");
      const created = await tx.query<UserRow>(
        `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
        [invite.email, name, invite.role, hash],
      );
      await tx.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [invite.id]);
      return toUser(created.rows[0]!);
    });
  }

  private async findOpenInvite(db: Pick<Db, "query">, token: string, lock = false): Promise<{ id: string; email: string; role: Role }> {
    const { rows } = await db.query<{ id: string; email: string; role: Role }>(
      `SELECT id, email, role FROM invites
        WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ${lock ? "FOR UPDATE" : ""}`,
      [sha256Hex(token)],
    );
    if (!rows[0]) throw notFound("This invite link is invalid or has expired", "invite_invalid");
    return rows[0];
  }

  // ---- Dashboard sessions ---------------------------------------------------

  async login(email: string, password: string, userAgent?: string): Promise<{ token: string; user: UserRecord; expiresAt: Date }> {
    const { rows } = await this.db.query<UserRow & { password_hash: string }>(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = $1`, [normaliseEmail(email)]);
    const row = rows[0];
    // Always run scrypt so response time does not reveal whether the account exists.
    const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !valid || row.disabled_at) throw unauthorized("Invalid email or password", "invalid_credentials");

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    await this.db.query("INSERT INTO sessions (id_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)", [sha256Hex(token), row.id, userAgent?.slice(0, 200) ?? null, expiresAt]);
    // Opportunistic cleanup keeps the table small without a scheduled job.
    void this.db.query("DELETE FROM sessions WHERE expires_at < now()").catch(() => {});
    return { token, user: toUser(row), expiresAt };
  }

  async resolveSession(token: string): Promise<Principal | undefined> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT u.id, u.email, u.name, u.role, u.disabled_at, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [sha256Hex(token)],
    );
    const u = rows[0];
    return u ? { userId: u.id, email: u.email, name: u.name, role: u.role, via: "chat" } : undefined;
  }

  async logout(token: string): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE id_hash = $1", [sha256Hex(token)]);
  }

  // ---- API keys -------------------------------------------------------------

  async createApiKey(actor: Principal, targetUserId: string, input: { name: string; expiresInDays?: number }): Promise<{ plaintext: string; key: ApiKeyRecord }> {
    if (actor.userId !== targetUserId && actor.role !== "admin") throw forbidden("Only admins can issue keys for other users");
    const name = input.name.trim();
    if (!name || name.length > 60) throw badRequest("Key name is required (max 60 characters)");
    if (input.expiresInDays !== undefined && (input.expiresInDays < 1 || input.expiresInDays > 730)) throw badRequest("Expiry must be between 1 and 730 days");

    const target = await this.getUser(targetUserId);
    if (!target || target.disabledAt) throw notFound("User not found or disabled");

    const active = await this.db.query<{ count: string }>(
      "SELECT count(*) FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
      [targetUserId],
    );
    if (Number(active.rows[0]?.count) >= MAX_ACTIVE_KEYS_PER_USER) throw conflict(`At most ${MAX_ACTIVE_KEYS_PER_USER} active keys per user. Revoke one first.`, "key_limit");

    const generated = generateApiKey();
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    await this.db.query(
      "INSERT INTO api_keys (user_id, name, prefix, key_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [targetUserId, name, generated.prefix, generated.hash, actor.userId, expiresAt],
    );
    const key = (await this.listApiKeys({ userId: targetUserId })).find((k) => k.prefix === generated.prefix)!;
    return { plaintext: generated.plaintext, key };
  }

  async listApiKeys(scope: { userId?: string }): Promise<ApiKeyRecord[]> {
    const { rows } = await this.db.query(
      `SELECT k.id, k.user_id, u.email AS user_email, k.name, k.prefix, k.created_at, k.expires_at, k.last_used_at, k.revoked_at
         FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE ($1::uuid IS NULL OR k.user_id = $1)
        ORDER BY k.created_at DESC`,
      [scope.userId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      name: r.name,
      prefix: r.prefix,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    }));
  }

  async revokeApiKey(actor: Principal, keyId: string): Promise<void> {
    const { rows } = await this.db.query<{ user_id: string }>("SELECT user_id FROM api_keys WHERE id = $1", [keyId]);
    if (!rows[0]) throw notFound("Key not found");
    if (rows[0].user_id !== actor.userId && actor.role !== "admin") throw forbidden("You can only revoke your own keys");
    await this.db.query("UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL", [keyId, actor.userId]);
  }

  /**
   * Authenticates a presented API key. Deliberately uncached: a revoked key or disabled
   * user must be rejected on the very next request, on every replica.
   */
  async authenticateApiKey(presented: string): Promise<KeyAuthResult> {
    const parsed = parseApiKey(presented);
    if (!parsed) return { ok: false, reason: "malformed" };

    const { rows } = await this.db.query<{
      id: string;
      key_hash: string;
      expires_at: Date | null;
      revoked_at: Date | null;
      last_used_at: Date | null;
      user_id: string;
      email: string;
      name: string;
      role: Role;
      disabled_at: Date | null;
    }>(
      `SELECT k.id, k.key_hash, k.expires_at, k.revoked_at, k.last_used_at, u.id AS user_id, u.email, u.name, u.role, u.disabled_at
         FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.prefix = $1`,
      [parsed.prefix],
    );
    const row = rows[0];
    if (!row || !safeEqualHex(row.key_hash, parsed.hash)) return { ok: false, reason: "unknown" };
    const principal: Principal = { userId: row.user_id, email: row.email, name: row.name, role: row.role, via: "api_key", keyPrefix: parsed.prefix };
    if (row.revoked_at) return { ok: false, reason: "revoked", owner: principal };
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired", owner: principal };
    if (row.disabled_at) return { ok: false, reason: "user_disabled", owner: principal };

    void this.db
      .query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')", [row.id])
      .catch(() => {});
    return { ok: true, principal };
  }
}
