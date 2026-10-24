import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Cryptographic primitives. Choices, and why:
 *
 * - Upstream credentials: AES-256-GCM, because they must be recoverable (the gateway
 *   presents them to upstreams). The key lives in a Kubernetes Secret, not in the DB.
 *   Ciphertexts carry a key id so keys can be rotated without downtime.
 * - API keys: SHA-256, not a slow hash. A key is 256 bits of CSPRNG output; there is no
 *   low-entropy secret to brute-force, so a fast hash is correct and keeps auth cheap.
 * - Passwords: scrypt, because humans choose them.
 */

const KEY_BYTES = 32;

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export class SecretBox {
  private readonly active: { id: string; key: Buffer };
  private readonly byId = new Map<string, Buffer>();

  constructor(activeKeyBase64: string, previousKeyBase64?: string) {
    const active = Buffer.from(activeKeyBase64, "base64");
    if (active.length !== KEY_BYTES) throw new Error("Encryption key must be 32 bytes");
    this.active = { id: keyId(active), key: active };
    this.byId.set(this.active.id, active);
    if (previousKeyBase64) {
      const previous = Buffer.from(previousKeyBase64, "base64");
      if (previous.length !== KEY_BYTES) throw new Error("Previous encryption key must be 32 bytes");
      this.byId.set(keyId(previous), previous);
    }
  }

  /** Format: v1.<keyId>.<iv>.<tag>.<ciphertext>, all base64url. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.active.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", this.active.id, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(payload: string): string {
    const [version, id, iv, tag, data] = payload.split(".");
    if (version !== "v1" || !id || !iv || !tag || !data) throw new Error("Malformed ciphertext");
    const key = this.byId.get(id);
    if (!key) throw new Error("Ciphertext was encrypted with an unknown key (is ENCRYPTION_KEY_PREVIOUS set?)");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }

  /** True if the payload was written with a key other than the active one. */
  needsRotation(payload: string): boolean {
    return payload.split(".")[1] !== this.active.id;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison for equal-purpose hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

// ---- API keys ---------------------------------------------------------------

export interface GeneratedApiKey {
  /** Shown to the user exactly once. */
  plaintext: string;
  /** Non-secret lookup handle, safe to display. */
  prefix: string;
  hash: string;
}

const KEY_PATTERN = /^sgk_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{43})$/;

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(6).toString("base64url").slice(0, 8);
  const secret = randomBytes(32).toString("base64url"); // 43 chars
  const plaintext = `sgk_${prefix}_${secret}`;
  return { plaintext, prefix, hash: sha256Hex(plaintext) };
}

export function parseApiKey(presented: string): { prefix: string; hash: string } | undefined {
  const match = KEY_PATTERN.exec(presented);
  if (!match) return undefined;
  return { prefix: match[1]!, hash: sha256Hex(presented) };
}

// ---- Passwords --------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

function scrypt(password: string, salt: Buffer, options: ScryptOptions & { keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, options.keylen, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const derived = await scrypt(password, Buffer.from(salt, "base64url"), { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Hash used to equalise timing when the account does not exist. */
export const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
