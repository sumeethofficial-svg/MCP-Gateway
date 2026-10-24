export interface WooConfig {
  /** In-cluster URL of WordPress, e.g. http://wordpress.store.svc.cluster.local */
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Bearer token the gateway must present. */
  authToken: string;
  /** IANA time zone used to resolve "today" and friends. Should match the store's zone. */
  timezone: string;
  timeoutMs: number;
  port: number;
  /** Short identifier surfaced in tool output so multi-store setups stay unambiguous. */
  storeName: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Environment variable ${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WooConfig {
  const timezone = env.STORE_TIMEZONE?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`STORE_TIMEZONE "${timezone}" is not a valid IANA time zone`);
  }
  return {
    baseUrl: required(env, "WOO_BASE_URL").replace(/\/+$/, ""),
    consumerKey: required(env, "WOO_CONSUMER_KEY"),
    consumerSecret: required(env, "WOO_CONSUMER_SECRET"),
    authToken: required(env, "MCP_AUTH_TOKEN"),
    timezone,
    timeoutMs: integer(env, "WOO_TIMEOUT_MS", 10_000),
    port: integer(env, "PORT", 8080),
    storeName: env.STORE_NAME?.trim() || "store",
  };
}
