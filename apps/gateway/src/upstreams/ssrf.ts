import dns from "node:dns";
import { BlockList, isIP } from "node:net";

/**
 * Server-side request forgery protection for admin-supplied upstream URLs.
 *
 * Threat: an admin account (or a compromised one) points the gateway at an address the
 * gateway can reach but the attacker cannot, such as the cloud metadata service, the
 * Kubernetes API, or an internal database, and uses the gateway as a proxy.
 *
 * Two tiers of address:
 *   - HARD blocked: loopback, link-local (includes 169.254.169.254 metadata), unspecified,
 *     multicast, reserved. Never allowed.
 *   - SOFT blocked: private ranges (RFC 1918, CGNAT, ULA...). Allowed only for hostnames that
 *     appear on the operator's allowlist, which is how in-cluster upstreams like
 *     currency-mcp.platform.svc.cluster.local are permitted without opening the whole cluster network.
 *
 * The same check runs again at connection time (see `createGuardedLookup`), which closes
 * the DNS rebinding gap between "validated" and "connected".
 */

const HARD = new BlockList();
HARD.addSubnet("0.0.0.0", 8, "ipv4");
HARD.addSubnet("127.0.0.0", 8, "ipv4");
HARD.addSubnet("169.254.0.0", 16, "ipv4");
HARD.addSubnet("224.0.0.0", 4, "ipv4");
HARD.addSubnet("240.0.0.0", 4, "ipv4");
HARD.addAddress("::", "ipv6");
HARD.addAddress("::1", "ipv6");
HARD.addSubnet("fe80::", 10, "ipv6");
HARD.addSubnet("ff00::", 8, "ipv6");

const SOFT = new BlockList();
SOFT.addSubnet("10.0.0.0", 8, "ipv4");
SOFT.addSubnet("172.16.0.0", 12, "ipv4");
SOFT.addSubnet("192.168.0.0", 16, "ipv4");
SOFT.addSubnet("100.64.0.0", 10, "ipv4");
SOFT.addSubnet("192.0.0.0", 24, "ipv4");
SOFT.addSubnet("192.0.2.0", 24, "ipv4");
SOFT.addSubnet("198.18.0.0", 15, "ipv4");
SOFT.addSubnet("198.51.100.0", 24, "ipv4");
SOFT.addSubnet("203.0.113.0", 24, "ipv4");
SOFT.addSubnet("fc00::", 7, "ipv6");
SOFT.addSubnet("2001:db8::", 32, "ipv6");

export type AddressClass = "public" | "private" | "blocked";

export interface SsrfPolicy {
  /** Hostnames (exact, or "*.suffix") allowed to resolve to private addresses and to use plain HTTP. */
  privateAllowlist: string[];
  /** Development and tests only. Never set by the Helm charts. Link-local stays blocked regardless. */
  allowLoopback?: boolean;
}

export class UrlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlRejectedError";
  }
}

/** Extracts the IPv4 address embedded in IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) IPv6 forms. */
function embeddedIpv4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return undefined;
}

/** The address a literal really points at, unwrapping IPv4-mapped and NAT64 forms. */
function effectiveAddress(ip: string): { address: string; family: "ipv4" | "ipv6" } | undefined {
  const version = isIP(ip);
  if (version === 0) return undefined;
  const embedded = version === 6 ? embeddedIpv4(ip) : undefined;
  if (embedded) return { address: embedded, family: "ipv4" };
  return { address: ip, family: version === 4 ? "ipv4" : "ipv6" };
}

function isLoopback(ip: string): boolean {
  const eff = effectiveAddress(ip);
  return !!eff && (eff.family === "ipv4" ? eff.address.startsWith("127.") : eff.address === "::1");
}

export function classifyIp(ip: string): AddressClass {
  const eff = effectiveAddress(ip);
  if (!eff) return "blocked";
  const { address, family } = eff;
  if (HARD.check(address, family)) return "blocked";
  if (SOFT.check(address, family)) return "private";
  return "public";
}

export function hostMatches(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
    // "woo-mcp.store-*.svc.cluster.local": a * inside a label matches letters, digits and hyphens only, never a dot,
    // so it can stand for a namespace-name suffix but cannot swallow a whole extra domain.
    if (pattern.includes("*")) {
      const re = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+")}$`);
      return re.test(host);
    }
    return host === pattern;
  });
}

type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses.map((a) => a.address))));
  });

/** Judges a set of resolved addresses for a host. Returns an explanation if the host must be refused. */
function judgeAddresses(hostname: string, addresses: string[], policy: SsrfPolicy): string | undefined {
  const allowlisted = hostMatches(hostname, policy.privateAllowlist);
  for (const address of addresses) {
    // Development escape hatch. Applies to loopback only; link-local and metadata stay blocked.
    if (policy.allowLoopback && isLoopback(address)) continue;
    const cls = classifyIp(address);
    if (cls === "blocked") {
      return `"${hostname}" resolves to ${address}, which is a loopback, link-local or otherwise reserved address (this includes cloud metadata endpoints)`;
    }
    if (cls === "private" && !allowlisted) {
      return `"${hostname}" resolves to the private address ${address}. Private networks are blocked unless the host is on the operator's allowlist (UPSTREAM_PRIVATE_ALLOWLIST)`;
    }
  }
  return undefined;
}

/** Validates an upstream URL submitted by an admin. Throws UrlRejectedError with a human-readable reason. */
export async function validateUpstreamUrl(raw: string, policy: SsrfPolicy, resolve: Resolver = defaultResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejectedError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UrlRejectedError("Only http and https URLs are supported");
  if (url.username || url.password) throw new UrlRejectedError("Credentials must not be embedded in the URL; use the credential field instead");
  if (url.hash) throw new UrlRejectedError("URL fragments are not allowed");
  if (!url.hostname) throw new UrlRejectedError("URL has no host");

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const allowlisted = hostMatches(hostname, policy.privateAllowlist);

  // Vet the addresses first so the most serious reason (e.g. cloud metadata) is the one reported.
  if (isIP(hostname)) {
    // Literal IPs cannot be allowlisted; use a DNS name for private upstreams.
    const verdict = judgeAddresses(hostname, [hostname], { ...policy, privateAllowlist: [] });
    if (verdict) throw new UrlRejectedError(verdict.replace(`"${hostname}" resolves to`, "Address is"));
  } else {
    let addresses: string[];
    try {
      addresses = await resolve(hostname);
    } catch {
      throw new UrlRejectedError(`Could not resolve "${hostname}"`);
    }
    if (addresses.length === 0) throw new UrlRejectedError(`Could not resolve "${hostname}"`);
    const verdict = judgeAddresses(hostname, addresses, policy);
    if (verdict) throw new UrlRejectedError(verdict);
  }

  // Plain HTTP would put the upstream credential on the wire in clear text.
  const loopbackDev = !!policy.allowLoopback && (hostname === "localhost" || isLoopback(hostname));
  if (url.protocol === "http:" && !allowlisted && !loopbackDev) {
    throw new UrlRejectedError("Plain http is only allowed for allowlisted in-cluster hosts. Use https");
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * A `lookup` function for undici's connector. Every connection re-resolves and re-checks the
 * address, so a hostname that passed validation but later rebinds to 169.254.169.254 is refused.
 */
export function createGuardedLookup(policy: SsrfPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as dns.LookupAddress[];
      const verdict = judgeAddresses(hostname, list.map((a) => a.address), policy);
      if (verdict) {
        const blocked: NodeJS.ErrnoException = new Error(`Blocked by SSRF policy: ${verdict}`);
        blocked.code = "ESSRFBLOCKED";
        return callback(blocked, "", 0);
      }
      if (options.all) return callback(null, list.map((a) => ({ address: a.address, family: a.family })));
      const first = list[0]!;
      return callback(null, first.address, first.family);
    });
  };
}
