import { describe, expect, it } from "vitest";
import { sanitizeLine, sanitizeLines, sanitizeMessage } from "./redact.js";

describe("log sanitising", () => {
  it("masks common credential shapes", () => {
    expect(sanitizeLine("Authorization: Bearer abcdef1234567890xyz")).not.toContain("abcdef1234567890xyz");
    expect(sanitizeLine("key sgk_5aZqZrT0_ALTE35oeJ691oDJKe used")).toBe("key [redacted-api-key] used");
    expect(sanitizeLine("postgres://gateway:hunter2@postgres:5432/gateway")).toBe("postgres://gateway:[redacted]@postgres:5432/gateway");
    expect(sanitizeLine("MCP_AUTH_TOKEN=supersecretvalue")).toBe("MCP_AUTH_TOKEN=[redacted]");
    expect(sanitizeLine('{"password":"p4ss","user":"bob"}')).not.toContain("p4ss");
    expect(sanitizeLine("consumer key ck_0123456789abcdef0123")).toContain("[redacted-woo-key]");
  });

  it("leaves ordinary diagnostics alone, including ones that merely mention a secret-like name", () => {
    const line = '{"level":60,"msg":"failed to start","err":"Missing required environment variable MCP_AUTH_TOKEN"}';
    expect(sanitizeLine(line)).toBe(line);
  });

  it("removes terminal escapes, control characters and invisible or bidirectional characters", () => {
    expect(sanitizeLine("\u001b[31mred\u001b[0m text")).toBe("red text");
    expect(sanitizeLine("a​b‮c⁦d\u0007e")).toBe("abcde");
  });

  it("caps line length and keeps only the most recent lines", () => {
    expect(sanitizeLine("x".repeat(1000), 100)).toHaveLength(100);
    const lines = sanitizeLines(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"), 3);
    expect(lines).toEqual(["line 7", "line 8", "line 9"]);
  });

  it("collapses whitespace in single messages", () => {
    expect(sanitizeMessage("  a \n\n  b   c ")).toBe("a b c");
    expect(sanitizeMessage(undefined)).toBeUndefined();
  });
});
