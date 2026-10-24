import { z } from "zod";

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** Upstreams declared by Helm values. Credentials are referenced by env var name, never inlined. */
const seededUpstream = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1).max(80),
  url: z.string().url(),
  /** Name of an env var (populated from a Kubernetes Secret) holding the bearer token. */
  credentialEnv: z.string().optional(),
  trustAnnotations: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type SeededUpstream = z.infer<typeof seededUpstream>;

const envSchema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),

  /** 32 random bytes, base64. Encrypts upstream credentials at rest. */
  ENCRYPTION_KEY: z.string().min(1),
  /** Optional previous key, accepted for decryption only, to allow rotation. */
  ENCRYPTION_KEY_PREVIOUS: z.string().optional(),

  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  COOKIE_SECURE: bool.default(false),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),

  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),

  UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  UPSTREAM_LIST_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  UPSTREAM_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  CATALOG_TTL_MS: z.coerce.number().int().nonnegative().default(15000),
  /** How long a cached tool list is still served after its upstream stops answering. */
  CATALOG_STALE_GRACE_MS: z.coerce.number().int().nonnegative().default(60000),
  HEALTH_INTERVAL_MS: z.coerce.number().int().nonnegative().default(10000),
  BREAKER_FAILURES: z.coerce.number().int().positive().default(3),
  BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(10000),
  /** Host patterns (exact or *.suffix) that may resolve to private addresses. */
  UPSTREAM_PRIVATE_ALLOWLIST: z.string().optional(),
  /** Development and tests only. The Helm charts never set this. */
  UPSTREAM_ALLOW_LOOPBACK: bool.default(false),
  UPSTREAM_MAX_RESULT_BYTES: z.coerce.number().int().positive().default(262144),
  SEEDED_UPSTREAMS: z.string().optional(),

  /** Multi-store provisioning: the internal address and bearer token of the provisioner. Unset = feature off. */
  PROVISIONER_URL: z.string().url().optional(),
  PROVISIONER_TOKEN: z.string().min(24).optional(),
  STORE_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(3600).default(15),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** Above this many tools the chat agent switches to search-then-call meta tools. */
  LAZY_TOOLS_THRESHOLD: z.coerce.number().int().positive().default(40),

  LLM_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  LLM_MODEL: z.string().default("llama-3.3-70b-versatile"),
  LLM_API_KEY: z.string().optional(),
  /** Optional. Some reasoning models only allow tool calls on Chat Completions with this set to "none" (or "low"...). */
  LLM_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().max(20).default(8),
});

export interface Config {
  env: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  encryptionKey: string;
  encryptionKeyPrevious?: string;
  publicUrl: string;
  cookieSecure: boolean;
  sessionTtlMs: number;
  bootstrapAdmin?: { email: string; password: string };
  upstream: {
    connectTimeoutMs: number;
    listTimeoutMs: number;
    callTimeoutMs: number;
    catalogTtlMs: number;
    catalogStaleGraceMs: number;
    healthIntervalMs: number;
    breakerFailures: number;
    breakerCooldownMs: number;
    privateAllowlist: string[];
    allowLoopback: boolean;
    maxResultBytes: number;
    seeded: SeededUpstream[];
  };
  /** Present when a provisioner is configured. */
  stores?: { url: string; token: string; syncIntervalMs: number };
  rateLimitPerMinute: number;
  lazyToolsThreshold: number;
  llm: { baseUrl: string; model: string; apiKey?: string; reasoningEffort?: string; timeoutMs: number; maxSteps: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;

  if (Buffer.from(e.ENCRYPTION_KEY, "base64").length !== 32) {
    throw new Error("Invalid configuration: ENCRYPTION_KEY must be 32 bytes, base64 encoded (generate with: openssl rand -base64 32)");
  }
  if (e.ENCRYPTION_KEY_PREVIOUS && Buffer.from(e.ENCRYPTION_KEY_PREVIOUS, "base64").length !== 32) {
    throw new Error("Invalid configuration: ENCRYPTION_KEY_PREVIOUS must be 32 bytes, base64 encoded");
  }
  if (!!e.BOOTSTRAP_ADMIN_EMAIL !== !!e.BOOTSTRAP_ADMIN_PASSWORD) {
    throw new Error("Invalid configuration: set both BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, or neither");
  }

  if (!!e.PROVISIONER_URL !== !!e.PROVISIONER_TOKEN) {
    throw new Error("Invalid configuration: set both PROVISIONER_URL and PROVISIONER_TOKEN, or neither");
  }

  let seeded: SeededUpstream[] = [];
  if (e.SEEDED_UPSTREAMS) {
    let raw: unknown;
    try {
      raw = JSON.parse(e.SEEDED_UPSTREAMS);
    } catch {
      throw new Error("Invalid configuration: SEEDED_UPSTREAMS must be valid JSON");
    }
    const result = z.array(seededUpstream).safeParse(raw);
    if (!result.success) throw new Error(`Invalid configuration: SEEDED_UPSTREAMS: ${result.error.issues.map((i) => i.message).join("; ")}`);
    seeded = result.data;
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    encryptionKey: e.ENCRYPTION_KEY,
    encryptionKeyPrevious: e.ENCRYPTION_KEY_PREVIOUS,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ""),
    cookieSecure: e.COOKIE_SECURE,
    sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
    bootstrapAdmin: e.BOOTSTRAP_ADMIN_EMAIL ? { email: e.BOOTSTRAP_ADMIN_EMAIL, password: e.BOOTSTRAP_ADMIN_PASSWORD! } : undefined,
    upstream: {
      connectTimeoutMs: e.UPSTREAM_CONNECT_TIMEOUT_MS,
      listTimeoutMs: e.UPSTREAM_LIST_TIMEOUT_MS,
      callTimeoutMs: e.UPSTREAM_CALL_TIMEOUT_MS,
      catalogTtlMs: e.CATALOG_TTL_MS,
      catalogStaleGraceMs: e.CATALOG_STALE_GRACE_MS,
      healthIntervalMs: e.HEALTH_INTERVAL_MS,
      breakerFailures: e.BREAKER_FAILURES,
      breakerCooldownMs: e.BREAKER_COOLDOWN_MS,
      privateAllowlist: csv(e.UPSTREAM_PRIVATE_ALLOWLIST),
      allowLoopback: e.UPSTREAM_ALLOW_LOOPBACK,
      maxResultBytes: e.UPSTREAM_MAX_RESULT_BYTES,
      seeded,
    },
    stores: e.PROVISIONER_URL ? { url: e.PROVISIONER_URL.replace(/\/+$/, ""), token: e.PROVISIONER_TOKEN!, syncIntervalMs: e.STORE_SYNC_INTERVAL_SECONDS * 1000 } : undefined,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    lazyToolsThreshold: e.LAZY_TOOLS_THRESHOLD,
    llm: { baseUrl: e.LLM_BASE_URL.replace(/\/+$/, ""), model: e.LLM_MODEL, apiKey: e.LLM_API_KEY, reasoningEffort: e.LLM_REASONING_EFFORT, timeoutMs: e.LLM_TIMEOUT_MS, maxSteps: e.AGENT_MAX_STEPS },
  };
}
