import { describe, expect, it } from "vitest";
import { classifyIp, hostMatches, validateUpstreamUrl, UrlRejectedError, type SsrfPolicy } from "./ssrf.js";

const policy: SsrfPolicy = { privateAllowlist: ["currency-mcp.platform.svc.cluster.local", "*.trusted.internal"] };
const resolveTo = (...ips: string[]) => async () => ips;

describe("classifyIp", () => {
  it.each([
    ["127.0.0.1", "blocked"],
    ["169.254.169.254", "blocked"], // cloud metadata
    ["0.0.0.0", "blocked"],
    ["224.0.0.1", "blocked"],
    ["::1", "blocked"],
    ["fe80::1", "blocked"],
    ["::ffff:127.0.0.1", "blocked"], // IPv4-mapped loopback
    ["::ffff:7f00:1", "blocked"], // same, hex form
    ["::ffff:169.254.169.254", "blocked"],
    ["64:ff9b::a9fe:a9fe", "blocked"], // NAT64-embedded metadata
    ["10.1.2.3", "private"],
    ["172.16.5.5", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["fd00::1", "private"],
    ["::ffff:10.0.0.1", "private"],
    ["8.8.8.8", "public"],
    ["172.32.0.1", "public"], // just outside 172.16/12
    ["2606:4700:4700::1111", "public"],
    ["not-an-ip", "blocked"],
  ])("%s -> %s", (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected);
  });

  it("allowLoopback never unblocks link-local or metadata", async () => {
    const dev: SsrfPolicy = { privateAllowlist: [], allowLoopback: true };
    await expect(validateUpstreamUrl("http://127.0.0.1:9000/mcp", dev, resolveTo("127.0.0.1"))).resolves.toBeInstanceOf(URL);
    await expect(validateUpstreamUrl("http://169.254.169.254/", dev, resolveTo("169.254.169.254"))).rejects.toThrow(/metadata|reserved/);
    await expect(validateUpstreamUrl("http://metadata.evil.example/", dev, resolveTo("169.254.169.254"))).rejects.toThrow(/metadata/);
  });
});

describe("hostMatches", () => {
  it("matches exact hosts and wildcard suffixes only", () => {
    expect(hostMatches("currency-mcp.platform.svc.cluster.local", policy.privateAllowlist)).toBe(true);
    expect(hostMatches("a.trusted.internal", policy.privateAllowlist)).toBe(true);
    expect(hostMatches("trusted.internal", policy.privateAllowlist)).toBe(false);
    expect(hostMatches("evil-trusted.internal", policy.privateAllowlist)).toBe(false);
    expect(hostMatches("currency-mcp.platform.svc.cluster.local.evil.com", policy.privateAllowlist)).toBe(false);
  });
});

describe("validateUpstreamUrl", () => {
  const reject = async (url: string, resolver = resolveTo("93.184.216.34"), p = policy) =>
    validateUpstreamUrl(url, p, resolver).then(
      () => "accepted",
      (e: unknown) => (e instanceof UrlRejectedError ? e.message : `unexpected: ${String(e)}`),
    );

  it("accepts a public https host", async () => {
    await expect(validateUpstreamUrl("https://mcp.example.com/mcp", policy, resolveTo("93.184.216.34"))).resolves.toBeInstanceOf(URL);
  });

  it("accepts an allowlisted in-cluster host over http", async () => {
    await expect(validateUpstreamUrl("http://currency-mcp.platform.svc.cluster.local:8080/mcp", policy, resolveTo("10.43.1.2"))).resolves.toBeInstanceOf(URL);
  });

  it("blocks the cloud metadata endpoint by IP and by name", async () => {
    expect(await reject("http://169.254.169.254/latest/meta-data")).toMatch(/reserved|Address is/);
    expect(await reject("https://metadata.attacker.example/", resolveTo("169.254.169.254"))).toMatch(/metadata/);
  });

  it("blocks loopback and localhost", async () => {
    expect(await reject("https://127.0.0.1:5432/")).toMatch(/Address is/);
    expect(await reject("https://localhost/", resolveTo("127.0.0.1", "::1"))).toMatch(/reserved/);
  });

  it("blocks private addresses unless the hostname is allowlisted", async () => {
    expect(await reject("https://intranet.example.com/", resolveTo("10.0.0.5"))).toMatch(/private address 10\.0\.0\.5/);
    expect(await reject("https://kubernetes.default.svc/", resolveTo("10.43.0.1"))).toMatch(/private address/);
    expect(await reject("https://10.0.0.5/")).toMatch(/Address is/);
  });

  it("blocks an allowlisted name that resolves to a hard-blocked address", async () => {
    expect(await reject("http://currency-mcp.platform.svc.cluster.local/", resolveTo("169.254.169.254"))).toMatch(/metadata/);
  });

  it("blocks when ANY resolved address is bad (multi-record rebinding trick)", async () => {
    expect(await reject("https://rebind.example.com/", resolveTo("93.184.216.34", "127.0.0.1"))).toMatch(/reserved/);
  });

  it("refuses plain http to public hosts, credentials in URLs, odd schemes and fragments", async () => {
    expect(await reject("http://mcp.example.com/")).toMatch(/Plain http/);
    expect(await reject("https://user:pass@mcp.example.com/")).toMatch(/Credentials/);
    expect(await reject("file:///etc/passwd")).toMatch(/http and https/);
    expect(await reject("gopher://mcp.example.com/")).toMatch(/http and https/);
    expect(await reject("https://mcp.example.com/#x")).toMatch(/fragment/);
    expect(await reject("nonsense")).toMatch(/valid URL/);
  });

  it("reports unresolvable hosts clearly", async () => {
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await reject("https://nope.example.invalid/", failing)).toMatch(/Could not resolve/);
  });

  it("allows loopback http only when explicitly enabled for development", async () => {
    expect(await reject("http://127.0.0.1:9000/mcp", resolveTo("127.0.0.1"))).toMatch(/Plain http|Address is/);
    expect(await reject("http://127.0.0.1:9000/mcp", resolveTo("127.0.0.1"), { privateAllowlist: [], allowLoopback: true })).toBe("accepted");
  });
});

describe("hostMatches with a wildcard inside a label", () => {
  const patterns = ["woo-mcp.store-*.svc.cluster.local"];
  it("matches store namespaces", () => {
    expect(hostMatches("woo-mcp.store-berlin.svc.cluster.local", patterns)).toBe(true);
    expect(hostMatches("woo-mcp.store-a-b-1.svc.cluster.local", patterns)).toBe(true);
    expect(hostMatches("WOO-MCP.store-berlin.svc.cluster.local.", patterns)).toBe(true);
  });
  it("does not match anything else", () => {
    expect(hostMatches("woo-mcp.store-.svc.cluster.local", patterns)).toBe(false); // nothing after the prefix
    expect(hostMatches("woo-mcp.platform.svc.cluster.local", patterns)).toBe(false);
    expect(hostMatches("postgres.store-berlin.svc.cluster.local", patterns)).toBe(false);
    expect(hostMatches("woo-mcp.store-x.evil.com", patterns)).toBe(false);
    expect(hostMatches("woo-mcp.store-x.y.svc.cluster.local", patterns)).toBe(false); // * never spans a dot
    expect(hostMatches("woo-mcp.store-berlin.svc.cluster.local.attacker.com", patterns)).toBe(false);
    expect(hostMatches("xwoo-mcp.store-berlin.svc.cluster.local", patterns)).toBe(false);
  });
  it("leaves the existing forms alone", () => {
    expect(hostMatches("a.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatches("example.com", ["*.example.com"])).toBe(false);
    expect(hostMatches("a.example.com", ["a.example.com"])).toBe(true);
  });
});
