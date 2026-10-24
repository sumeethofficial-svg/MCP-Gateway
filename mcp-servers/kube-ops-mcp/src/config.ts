/**
 * Policy for what this server may touch. Everything here is deliberately explicit:
 * there is no wildcard namespace and no "all deployments". The same allowlist is rendered
 * into the Kubernetes RBAC Role by the Helm chart (as `resourceNames`), so the API server
 * enforces it even if this process were compromised.
 */
export interface WriteTarget {
  namespace: string;
  name: string;
  /** Upper bound for scale_deployment. 1 means "restart only": the workload must not be scaled out. */
  maxReplicas: number;
}

export interface KubeOpsConfig {
  /** Namespaces the read tools may inspect. */
  namespaces: string[];
  /** The only deployments restart_deployment and scale_deployment may change. */
  writeTargets: WriteTarget[];
  /** Scale-to-zero is refused: it is an outage, not a recovery. */
  minReplicas: number;
  maxLogLines: number;
  /** Minimum gap between two changes to the same deployment (stops a confused or hijacked agent from looping). */
  writeCooldownMs: number;
}

/** RFC 1123 label: what a namespace or deployment name can be. Also what keeps path segments safe. */
export const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** RFC 1123 subdomain: what a pod name can be (dots allowed). */
export const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** "platform/currency-mcp:3,store/wordpress:1" -> targets. The ":max" part is optional (default 1). */
export function parseWriteTargets(raw: string | undefined): WriteTarget[] {
  return csv(raw).map((item) => {
    const match = /^([^/:\s]+)\/([^/:\s]+)(?::(\d+))?$/.exec(item);
    if (!match) throw new Error(`Invalid WRITE_ALLOWLIST entry "${item}" (expected namespace/name or namespace/name:maxReplicas)`);
    const [, namespace, name, max] = match as unknown as [string, string, string, string | undefined];
    return { namespace, name, maxReplicas: max === undefined ? 1 : Number.parseInt(max, 10) };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KubeOpsConfig {
  const namespaces = csv(env.ALLOWED_NAMESPACES);
  if (namespaces.length === 0) throw new Error("Missing required environment variable ALLOWED_NAMESPACES");
  for (const ns of namespaces) {
    if (!DNS_LABEL.test(ns)) throw new Error(`Invalid namespace "${ns}" in ALLOWED_NAMESPACES`);
  }

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return n;
  };

  const minReplicas = int("MIN_REPLICAS", 1, 1, 10);
  const writeTargets = parseWriteTargets(env.WRITE_ALLOWLIST);
  const seen = new Set<string>();
  for (const t of writeTargets) {
    if (!namespaces.includes(t.namespace)) throw new Error(`WRITE_ALLOWLIST entry ${t.namespace}/${t.name} is outside ALLOWED_NAMESPACES`);
    if (!DNS_LABEL.test(t.name)) throw new Error(`Invalid deployment name "${t.name}" in WRITE_ALLOWLIST`);
    if (t.maxReplicas < minReplicas || t.maxReplicas > 20) throw new Error(`WRITE_ALLOWLIST entry ${t.namespace}/${t.name} has maxReplicas outside ${minReplicas}..20`);
    const key = `${t.namespace}/${t.name}`;
    if (seen.has(key)) throw new Error(`Duplicate WRITE_ALLOWLIST entry ${key}`);
    seen.add(key);
  }

  return {
    namespaces,
    writeTargets,
    minReplicas,
    maxLogLines: int("LOG_TAIL_MAX_LINES", 300, 10, 1000),
    writeCooldownMs: int("WRITE_COOLDOWN_SECONDS", 15, 0, 3600) * 1000,
  };
}
