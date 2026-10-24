import { describe, expect, it } from "vitest";
import { loadConfig, parseWriteTargets } from "./config.js";

describe("kube-ops config", () => {
  it("parses write targets with an optional replica ceiling", () => {
    expect(parseWriteTargets("platform/currency-mcp:3, store/wordpress")).toEqual([
      { namespace: "platform", name: "currency-mcp", maxReplicas: 3 },
      { namespace: "store", name: "wordpress", maxReplicas: 1 },
    ]);
    expect(() => parseWriteTargets("currency-mcp")).toThrow(/Invalid WRITE_ALLOWLIST/);
    expect(() => parseWriteTargets("a/b/c")).toThrow(/Invalid WRITE_ALLOWLIST/);
  });

  it("requires at least one namespace and keeps writes inside the readable namespaces", () => {
    expect(() => loadConfig({})).toThrow(/ALLOWED_NAMESPACES/);
    expect(() => loadConfig({ ALLOWED_NAMESPACES: "platform", WRITE_ALLOWLIST: "store/wordpress:1" })).toThrow(/outside ALLOWED_NAMESPACES/);
    expect(() => loadConfig({ ALLOWED_NAMESPACES: "Bad_Name" })).toThrow(/Invalid namespace/);
  });

  it("rejects duplicate or out-of-range targets and applies defaults", () => {
    expect(() => loadConfig({ ALLOWED_NAMESPACES: "platform", WRITE_ALLOWLIST: "platform/a:2,platform/a:2" })).toThrow(/Duplicate/);
    expect(() => loadConfig({ ALLOWED_NAMESPACES: "platform", WRITE_ALLOWLIST: "platform/a:99" })).toThrow(/maxReplicas/);
    const cfg = loadConfig({ ALLOWED_NAMESPACES: "platform,store" });
    expect(cfg).toMatchObject({ namespaces: ["platform", "store"], writeTargets: [], minReplicas: 1, maxLogLines: 300, writeCooldownMs: 15_000 });
  });
});
