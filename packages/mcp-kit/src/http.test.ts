import type { AddressInfo } from "node:net";
import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpHttpServer, ok, READ_ONLY, tokensMatch } from "./index.js";

const TOKEN = "test-token-123";
let server: http.Server;
let base: string;
let ready = true;

beforeAll(async () => {
  server = createMcpHttpServer({
    name: "kit-test",
    version: "0.0.1",
    authToken: TOKEN,
    logger: pino({ level: "silent" }),
    ready: async () => {
      if (!ready) throw new Error("down");
    },
    registerTools: (s) => {
      s.registerTool(
        "echo",
        { description: "Echo text back", inputSchema: { text: z.string() }, annotations: READ_ONLY },
        async ({ text }) => ok({ text }),
      );
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connect(token?: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  await client.connect(transport);
  return client;
}

describe("mcp-kit http server", () => {
  it("lists and calls tools with a valid token", async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.structuredContent).toEqual({ text: "hi" });
    await client.close();
  });

  it("rejects missing and wrong tokens with 401", async () => {
    for (const header of [undefined, "Bearer nope", "Basic abc"]) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(header ? { authorization: header } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    }
  });

  it("validates tool input", async () => {
    const client = await connect(TOKEN);
    const result = await client.callTool({ name: "echo", arguments: { text: 42 } }).catch((e: unknown) => e);
    const failed = result instanceof Error || (result as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    await client.close();
  });

  it("is POST-only on /mcp", async () => {
    const res = await fetch(`${base}/mcp`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });

  it("serves health and readiness without auth, and reports not-ready", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    ready = true;
  });

  it("rejects oversized and malformed bodies", async () => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${base}/mcp`, { method: "POST", headers, body: "{not json" })).status).toBe(400);
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { pad: "a".repeat(2 * 1024 * 1024) } });
    expect((await fetch(`${base}/mcp`, { method: "POST", headers, body: big })).status).toBe(413);
  });

  it("refuses to start without a token unless anonymous is explicit", () => {
    expect(() => createMcpHttpServer({ name: "x", version: "1", logger: pino({ level: "silent" }), registerTools: () => {} })).toThrow(/auth token/);
  });

  it("compares tokens in constant time without throwing on length mismatch", () => {
    expect(tokensMatch("a", "abcdef")).toBe(false);
    expect(tokensMatch("abcdef", "abcdef")).toBe(true);
  });
});
