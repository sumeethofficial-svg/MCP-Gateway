import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { createEnv, startCurrency, startKubeOps, textOf, type TestEnv, type TestUpstream } from "./harness.js";

let env: TestEnv;
let app: FastifyInstance;
let ops: TestUpstream;
let currency: TestUpstream;
let baseUrl: string;
let adminCookie: string;

const H = { "x-requested-with": "mcp-portal" };

async function api(method: string, url: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const res = await app.inject({
    method: method as "GET",
    url,
    payload: opts.body as object | undefined,
    headers: { ...(method === "GET" ? {} : H), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
  });
  const cookie = (res.cookies[0] ? `${res.cookies[0].name}=${res.cookies[0].value}` : undefined) as string | undefined;
  return { status: res.statusCode, json: res.body ? (safeJson(res.body) as any) : undefined, cookie, headers: res.headers };
}
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

async function mcpClient(key: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}

beforeAll(async () => {
  env = await createEnv({ PUBLIC_URL: "http://localhost" });
  ops = await startKubeOps();
  currency = await startCurrency();
  await env.addUpstream(ops, "kube-ops");
  await env.addUpstream(currency, "currency");
  await env.c.auth.bootstrapAdmin("boss@example.com", "correct horse battery");
  app = await buildApp(env.c);
  await app.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;
  adminCookie = (await api("POST", "/api/auth/login", { body: { email: "boss@example.com", password: "correct horse battery" } })).cookie!;
});

afterAll(async () => {
  await app.close();
  await Promise.all([ops.close(), currency.close()]);
  await env.cleanup();
});

describe("auth and CSRF", () => {
  it("logs in and returns the user", async () => {
    const r = await api("GET", "/api/auth/me", { cookie: adminCookie });
    expect(r.status).toBe(200);
    expect(r.json.user.role).toBe("admin");
  });
  it("rejects bad credentials identically for unknown and known accounts", async () => {
    const a = await api("POST", "/api/auth/login", { body: { email: "boss@example.com", password: "nope" } });
    const b = await api("POST", "/api/auth/login", { body: { email: "ghost@example.com", password: "nope" } });
    expect(a.status).toBe(401);
    expect(b.json.error.message).toBe(a.json.error.message);
  });
  it("requires a session", async () => {
    expect((await api("GET", "/api/servers")).status).toBe(401);
  });
  it("rejects state-changing requests without the CSRF header or from another origin", async () => {
    const noHeader = await app.inject({ method: "POST", url: "/api/keys", payload: { name: "x" }, headers: { cookie: adminCookie } });
    expect(noHeader.statusCode).toBe(403);
    const crossOrigin = await api("POST", "/api/keys", { cookie: adminCookie, body: { name: "x" }, headers: { origin: "https://evil.example" } });
    expect(crossOrigin.status).toBe(403);
  });
  it("throttles repeated failed logins", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await api("POST", "/api/auth/login", { body: { email: "victim@example.com", password: "x" } })).status;
    expect(last).toBe(429);
  });
});

describe("invites, roles and keys", () => {
  let memberCookie: string;
  let memberKey: string;
  let memberKeyId: string;
  let memberId: string;

  it("invites a member who accepts and is signed in", async () => {
    const inv = await api("POST", "/api/invites", { cookie: adminCookie, body: { email: "mia@example.com" } });
    expect(inv.status).toBe(200);
    const token = new URL(inv.json.inviteUrl).searchParams.get("token")!;
    expect((await api("GET", `/api/invites/preview?token=${encodeURIComponent(token)}`)).json.email).toBe("mia@example.com");
    const acc = await api("POST", "/api/invites/accept", { body: { token, name: "Mia", password: "a long password 123" } });
    expect(acc.status).toBe(200);
    memberCookie = acc.cookie!;
    memberId = acc.json.user.id;
    // single use
    expect((await api("POST", "/api/invites/accept", { body: { token, name: "Mia", password: "a long password 123" } })).status).toBeGreaterThanOrEqual(400);
  });

  it("members cannot reach admin routes, and see a reduced server view", async () => {
    expect((await api("GET", "/api/users", { cookie: memberCookie })).status).toBe(403);
    expect((await api("POST", "/api/servers", { cookie: memberCookie, body: { slug: "x", name: "x", url: "http://x", authType: "none" } })).status).toBe(403);
    const view = (await api("GET", "/api/servers", { cookie: memberCookie })).json.servers[0];
    expect(view).not.toHaveProperty("url");
    expect(view).not.toHaveProperty("hasCredential");
    const adminView = (await api("GET", "/api/servers", { cookie: adminCookie })).json.servers[0];
    expect(adminView).toHaveProperty("url");
    expect(JSON.stringify(adminView)).not.toContain(ops.token);
  });

  it("issues a key once, authenticates MCP with it, and revocation is immediate", async () => {
    const created = await api("POST", "/api/keys", { cookie: memberCookie, body: { name: "laptop" } });
    memberKey = created.json.plaintext;
    memberKeyId = created.json.key.id;
    expect(memberKey).toMatch(/^sgk_/);
    expect(JSON.stringify((await api("GET", "/api/keys", { cookie: memberCookie })).json)).not.toContain(memberKey);

    const client = await mcpClient(memberKey);
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    await client.close();

    expect((await api("DELETE", `/api/keys/${memberKeyId}`, { cookie: memberCookie })).status).toBe(200);
    const after = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
    const audit = await api("GET", `/api/audit?userId=${memberId}&outcome=denied`, { cookie: adminCookie });
    expect(audit.json.rows.length).toBeGreaterThan(0);
  });

  it("audit rows carry the (redacted) call arguments the dashboard displays", async () => {
    const key = await api("POST", "/api/keys", { cookie: adminCookie, body: { name: "audit-args" } });
    const client = await mcpClient(key.json.plaintext);
    await client.callTool({ name: "kube-ops__list_pods", arguments: { namespace: "platform", api_key: "do-not-store" } });
    await client.close();
    const rows = (await api("GET", "/api/audit?tool=list_pods", { cookie: adminCookie })).json.rows as { argsPreview: string | null }[];
    const preview = rows.find((r) => r.argsPreview?.includes("platform"))?.argsPreview ?? "";
    expect(JSON.parse(preview)).toMatchObject({ namespace: "platform", api_key: "[redacted]" });
    expect(preview).not.toContain("do-not-store");
  });

  it("rejects missing or garbage keys and non-POST methods on /mcp", async () => {
    const r = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
    expect((await fetch(`${baseUrl}/mcp`, { method: "GET" })).status).toBe(405);
  });

  it("a member cannot revoke someone else's key", async () => {
    const adminKey = await api("POST", "/api/keys", { cookie: adminCookie, body: { name: "admin" } });
    const r = await api("DELETE", `/api/keys/${adminKey.json.key.id}`, { cookie: memberCookie });
    expect(r.status).toBeGreaterThanOrEqual(403);
  });

  it("members only see their own audit rows", async () => {
    const rows = (await api("GET", "/api/audit", { cookie: memberCookie })).json.rows as { userId?: string; user?: { id: string } }[];
    for (const row of rows) expect(row.userId ?? row.user?.id).toBe(memberId);
  });
});

describe("server admin API", () => {
  it("refuses to register a cloud-metadata URL (SSRF)", async () => {
    const r = await api("POST", "/api/servers", { cookie: adminCookie, body: { slug: "meta", name: "Meta", url: "http://169.254.169.254/mcp", authType: "none" } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
  it("creates, disables and removes a server", async () => {
    const t = await startCurrency();
    const created = await api("POST", "/api/servers", {
      cookie: adminCookie,
      body: { slug: "extra", name: "Extra", url: t.mcpUrl, authType: "bearer", credential: t.token },
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.json)).not.toContain(t.token);
    const id = created.json.server.id;
    const off = await api("PATCH", `/api/servers/${id}`, { cookie: adminCookie, body: { enabled: false } });
    expect(off.json.server.status).toBe("disabled");
    expect((await api("DELETE", `/api/servers/${id}`, { cookie: adminCookie })).status).toBe(200);
    await t.close();
  });
  it("exposes health and metrics", async () => {
    expect((await api("GET", "/healthz")).status).toBe(200);
    expect((await api("GET", "/readyz")).status).toBe(200);
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toContain("gateway_");
  });
});

describe("helm seeding", () => {
  it("is idempotent and keeps an admin's disable across restarts", async () => {
    const seed = [{ slug: "seeded", name: "Seeded", url: ops.mcpUrl, trustAnnotations: true, enabled: true }];
    await env.c.registry.seed(seed as any, {});
    const first = (await env.c.registry.list()).find((s) => s.slug === "seeded")!;
    expect(first.managedBy).toBe("helm");
    await env.c.admin.update(first.id, { enabled: false });
    await env.c.registry.seed(seed as any, {});
    expect((await env.c.registry.list()).filter((s) => s.slug === "seeded")).toHaveLength(1);
    expect((await env.c.registry.list()).find((s) => s.slug === "seeded")!.enabled).toBe(false);
  });
});
