import { z } from "zod";

const num = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  PORT: num(8080, 1, 65535),
  /** Bearer token the gateway presents. Nothing else may call this service. */
  PROVISIONER_TOKEN: z.string().min(24, "PROVISIONER_TOKEN must be at least 24 characters"),
  STORE_NS_PREFIX: z.string().regex(/^[a-z0-9]([-a-z0-9]*-)$/, "must end with a hyphen, e.g. store-").default("store-"),
  STORE_BASE_DOMAIN: z.string().min(3).default("stores.localtest.me"),
  STORE_SCHEME: z.enum(["http", "https"]).default("http"),
  MAX_STORES_PER_USER: num(3, 1, 50),
  MAX_STORES_TOTAL: num(8, 1, 200),
  PROVISION_TIMEOUT_SECONDS: num(1200, 60, 7200),
  RECONCILE_INTERVAL_MS: num(4000, 200, 60000),
  CHART_PATH: z.string().default("/charts/mcp-store"),
  /** Base values for the store chart as JSON (rendered from the platform chart). */
  STORE_VALUES_JSON: z.string().default("{}"),
  HELM_BIN: z.string().default("helm"),
  WORK_DIR: z.string().default("/tmp/provisioner"),
});

export interface Config {
  port: number;
  token: string;
  nsPrefix: string;
  baseDomain: string;
  scheme: "http" | "https";
  maxPerUser: number;
  maxTotal: number;
  timeoutMs: number;
  reconcileMs: number;
  chartPath: string;
  baseValues: Record<string, unknown>;
  helmBin: string;
  workDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  let baseValues: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(e.STORE_VALUES_JSON);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not an object");
    baseValues = raw as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid configuration: STORE_VALUES_JSON must be a JSON object (${(err as Error).message})`);
  }
  return {
    port: e.PORT,
    token: e.PROVISIONER_TOKEN,
    nsPrefix: e.STORE_NS_PREFIX,
    baseDomain: e.STORE_BASE_DOMAIN,
    scheme: e.STORE_SCHEME,
    maxPerUser: e.MAX_STORES_PER_USER,
    maxTotal: e.MAX_STORES_TOTAL,
    timeoutMs: e.PROVISION_TIMEOUT_SECONDS * 1000,
    reconcileMs: e.RECONCILE_INTERVAL_MS,
    chartPath: e.CHART_PATH,
    baseValues,
    helmBin: e.HELM_BIN,
    workDir: e.WORK_DIR,
  };
}
