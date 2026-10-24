import { ok, READ_ONLY, WRITE } from "@mcp-portal/mcp-kit";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/principal.js";
import { hashPassword } from "../src/crypto.js";
import { buildApp } from "../src/http/app.js";
import { ProvisionerError, type CreateStoreRequest, type ProvisionerClient, type StoreInfo, type StorePhase } from "../src/stores/client.js";
import { createEnv, startUpstream, textOf, type TestEnv, type TestUpstream } from "./harness.js";

/** A shop's MCP server: one read tool and one write tool, tagged with the shop's name. */
const startShop = (store: string) =>
  startUpstream(`shop-${store}`, (s) => {
    s.registerTool("list_products", { description: "List products.", inputSchema: {}, annotations: READ_ONLY }, () => ok({ store, products: [] }));
    s.registerTool("create_product", { description: "Create a product.", inputSchema: { name: z.string() }, annotations: WRITE }, () => ok({ store, created: true }));
  });

/** In-memory stand-in for the provisioner service. */
class FakeProvisioner implements ProvisionerClient {
  stores = new Map<string, StoreInfo>();
  shops = new Map<string, { url: string; token: string }>();
  down = false;
  creates: CreateStoreRequest[] = [];
  removed: string[] = [];

  private check() {
    if (this.down) throw new ProvisionerError(503, "provisioner_unavailable", "down");
  }
  async list() {
    this.check();
    return [...this.stores.values()];
  }
  async get(id: string) {
    this.check();
    return this.stores.get(id);
  }
  async create(input: CreateStoreRequest) {
    this.check();
    this.creates.push(input);
    const existing = this.stores.get(input.id);
    if (existing) {
      if (existing.ownerId !== input.ownerId) throw new ProvisionerError(409, "id_taken", "That store id is already in use");
      return { store: existing, created: false };
    }
    const store = this.put(input.id, input.name, input.ownerId, "Provisioning");
    return { store, created: true };
  }
  async remove(id: string) {
    this.check();
    const s = this.stores.get(id);
    if (!s) throw new ProvisionerError(404, "not_found", "Store not found");
    this.removed.push(id);
    s.phase = "Deleting";
    return s;
  }
  async mcpEndpoint(id: string) {
    this.check();
    const shop = this.shops.get(id);
    if (!shop || this.stores.get(id)?.phase !== "Ready") throw new ProvisionerError(409, "not_ready", "not ready");
    return shop;
  }
  put(id: string, name: string, ownerId: string, phase: StorePhase): StoreInfo {
    const store: StoreInfo = { id, name, namespace: `store-${id}`, phase, reason: null, url: `http://${id}.stores.localtest.me`, ownerId, ownerEmail: null, createdAt: new Date().toISOString() };
    this.stores.set(id, store);
    return store;
  }
}

const prov = new FakeProvisioner();
let env: TestEnv;
let app: FastifyInstance;
let admin: Principal;
let alice: Principal;
let bob: Principal;
let berlin: TestUpstream;
let paris: TestUpstream;

const names = async (p: Principal) => (await env.c.gateway.listVisibleTools(p)).tools.map((t) => t.name);
const sync = () => env.c.stores!.sync();

beforeAll(async () => {
  env = await createEnv({}, { provisioner: prov });
  admin = await env.makeUser("admin", "admin@example.com");
  alice = await env.makeUser("member", "alice@example.com");
  bob = await env.makeUser("member", "bob@example.com");
  berlin = await startShop("berlin");
  paris = await startShop("paris");
  prov.shops.set("berlin", { url: berlin.mcpUrl, token: berlin.token });
  prov.shops.set("paris", { url: paris.mcpUrl, token: paris.token });
  app = await buildApp(env.c);
});

afterAll(async () => {
  await app.close();
  await Promise.all([berlin.close(), paris.close()]);
  await env.cleanup();
});

describe("registering stores with the gateway", () => {
  it("does not register a store until it is Ready", async () => {
    prov.put("berlin", "Berlin Books", alice.userId, "Provisioning");
    await sync();
    expect(await env.c.registry.getStoreServer("berlin")).toBeUndefined();
    expect(await names(admin)).not.toContain("woo-berlin__list_products");
  });

  it("registers a Ready store as woo-<id> with its own credential and exposes store-identifying tool names", async () => {
    prov.stores.get("berlin")!.phase = "Ready";
    await sync();
    const server = await env.c.registry.getStoreServer("berlin");
    expect(server).toMatchObject({ slug: "woo-berlin", name: "Berlin Books", managedBy: "provisioner", ownerId: alice.userId, trustAnnotations: true, authType: "bearer", credential: berlin.token });
    expect(await names(admin)).toEqual(expect.arrayContaining(["woo-berlin__list_products", "woo-berlin__create_product"]));
  });

  it("keeps two stores apart: same tools, different names, different shops", async () => {
    prov.put("paris", "Paris Pens", bob.userId, "Ready");
    await sync();
    const a = await env.c.gateway.callTool(admin, "woo-berlin__list_products", {});
    const b = await env.c.gateway.callTool(admin, "woo-paris__list_products", {});
    expect((a.structuredContent as { store: string }).store).toBe("berlin");
    expect((b.structuredContent as { store: string }).store).toBe("paris");
  });

  it("lets only the owner (and admins) call a store's tools, including its write tools", async () => {
    expect(await names(alice)).toEqual(expect.arrayContaining(["woo-berlin__list_products", "woo-berlin__create_product"]));
    expect(await names(alice)).not.toContain("woo-paris__list_products");
    expect(await names(bob)).not.toContain("woo-berlin__list_products");

    const own = await env.c.gateway.callTool(alice, "woo-berlin__create_product", { name: "Atlas" });
    expect(own.isError, textOf(own)).toBeFalsy();
    const other = await env.c.gateway.callTool(alice, "woo-paris__list_products", {});
    expect(other.isError).toBe(true);
    expect(textOf(other)).toContain("belongs to another user");
  });

  it("a broad allow rule for members does not open one user's store to another", async () => {
    await env.c.policy.create({ subjectType: "role", subject: "member", serverSlug: "*", toolName: "*", effect: "allow" }, admin.userId);
    expect(await names(bob)).not.toContain("woo-berlin__list_products");
    const { rows } = await env.db.query<{ id: string }>("SELECT id FROM tool_policies");
    for (const r of rows) await env.c.policy.remove(r.id);
  });

  it("follows a rotated credential", async () => {
    prov.shops.set("paris", { url: paris.mcpUrl, token: "rotated-token-that-the-shop-does-not-accept" });
    await sync();
    expect((await env.c.registry.getStoreServer("paris"))!.credential).toBe("rotated-token-that-the-shop-does-not-accept");
    prov.shops.set("paris", { url: paris.mcpUrl, token: paris.token });
    await sync();
    expect((await env.c.registry.getStoreServer("paris"))!.credential).toBe(paris.token);
  });

  it("refuses an address the SSRF policy rejects", async () => {
    prov.put("meta", "Metadata", alice.userId, "Ready");
    prov.shops.set("meta", { url: "http://169.254.169.254/latest/meta-data", token: "x".repeat(30) });
    await sync();
    expect(await env.c.registry.getStoreServer("meta")).toBeUndefined();
    prov.stores.delete("meta");
  });

  it("does not take over an unrelated server that already uses the slug", async () => {
    const decoy = await startShop("decoy");
    await env.addUpstream(decoy, "woo-clash");
    prov.put("clash", "Clash", alice.userId, "Ready");
    prov.shops.set("clash", { url: berlin.mcpUrl, token: berlin.token });
    await sync();
    expect(await env.c.registry.getStoreServer("clash")).toBeUndefined();
    expect((await env.c.registry.getBySlug("woo-clash"))!.managedBy).toBe("admin");
    prov.stores.delete("clash");
    await decoy.close();
  });
});

describe("keeping the registry true to the provisioner", () => {
  it("changes nothing while the provisioner is unreachable", async () => {
    prov.down = true;
    await sync();
    prov.down = false;
    expect(await env.c.registry.getStoreServer("berlin")).toBeDefined();
    expect(await env.c.registry.getStoreServer("paris")).toBeDefined();
  });

  it("withdraws a store's tools when it is deleted, failed or gone", async () => {
    prov.stores.get("paris")!.phase = "Deleting";
    await sync();
    expect(await env.c.registry.getStoreServer("paris")).toBeUndefined();
    expect(await names(admin)).not.toContain("woo-paris__list_products");

    prov.stores.delete("berlin"); // the namespace is gone entirely
    await sync();
    expect(await env.c.registry.getStoreServer("berlin")).toBeUndefined();
    const left = (await env.db.query("SELECT 1 FROM upstream_servers WHERE managed_by = 'provisioner'")).rowCount;
    expect(left).toBe(0);
    expect((await env.db.query("SELECT 1 FROM tool_pins p JOIN upstream_servers s ON s.id = p.server_id WHERE s.managed_by = 'provisioner'")).rowCount).toBe(0);
  });

  it("coalesces a burst of sync requests", async () => {
    prov.stores.clear();
    await Promise.all([sync(), sync(), sync(), sync()]);
    expect(await env.c.registry.listStoreServers()).toHaveLength(0);
  });
});

describe("the stores API", () => {
  const H = { "x-requested-with": "mcp-portal" };
  const cookies: Record<string, string> = {};
  const call = async (who: string, method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as "GET", url, payload: body as object | undefined, headers: { ...(method === "GET" ? {} : H), cookie: cookies[who]! } });
    return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as any) : undefined };
  };

  beforeAll(async () => {
    await env.db.query("UPDATE users SET password_hash = $1 WHERE email = 'admin@example.com'", [await hashPassword("correct horse battery")]);
    cookies.boss = await login("admin@example.com", "correct horse battery");
    for (const who of ["mia", "sam"]) {
      const inv = await env.c.auth.createInvite(await principalOf("admin@example.com"), `${who}@example.com`, "member");
      await env.c.auth.acceptInvite(inv.token, { name: who, password: "a long password 123" });
      cookies[who] = await login(`${who}@example.com`, "a long password 123");
    }
  });
  const login = async (email: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, headers: H });
    if (!res.cookies[0]) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
    return `${res.cookies[0].name}=${res.cookies[0].value}`;
  };
  const principalOf = async (email: string): Promise<Principal> => {
    const u = (await env.c.auth.listUsers()).find((x) => x.email === email)!;
    return { userId: u.id, email: u.email, name: u.name, role: u.role, via: "chat" };
  };

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stores" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a store for the signed-in user, and a retry with the same id returns the same store", async () => {
    prov.stores.clear();
    const first = await call("mia", "POST", "/api/stores", { name: "Mia's Mugs", id: "mugs-1" });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ created: true, store: { id: "mugs-1", name: "Mia's Mugs", phase: "Provisioning" } });
    const mia = await principalOf("mia@example.com");
    expect(prov.creates.at(-1)).toMatchObject({ id: "mugs-1", ownerId: mia.userId, ownerEmail: "mia@example.com" });

    const retry = await call("mia", "POST", "/api/stores", { name: "Mia's Mugs", id: "mugs-1" });
    expect(retry.status).toBe(200);
    expect(retry.json.created).toBe(false);
    expect(prov.stores.size).toBe(1);
  });

  it("derives a valid id from the name when none is given", async () => {
    const res = await call("mia", "POST", "/api/stores", { name: "Ünïcode & Spaces!!" });
    expect(res.status).toBe(201);
    expect(res.json.store.id).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(res.json.store.id.length).toBeLessThanOrEqual(18);
  });

  it("validates input", async () => {
    expect((await call("mia", "POST", "/api/stores", { name: "   " })).status).toBe(400);
    expect((await call("mia", "POST", "/api/stores", { name: "ok", id: "Bad ID" })).status).toBe(400);
  });

  it("passes the provisioner's limit message through", async () => {
    const original = prov.create.bind(prov);
    prov.create = async () => {
      throw new ProvisionerError(409, "store_limit", "You can have at most 3 stores. Delete one first");
    };
    const res = await call("sam", "POST", "/api/stores", { name: "Too many" });
    prov.create = original;
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({ code: "store_limit", message: expect.stringContaining("at most 3") });
  });

  it("shows members only their own stores and admins all of them", async () => {
    await call("sam", "POST", "/api/stores", { name: "Sam's Socks", id: "socks" });
    const mine = (await call("mia", "GET", "/api/stores")).json.stores.map((s: StoreInfo) => s.id);
    expect(mine).toContain("mugs-1");
    expect(mine).not.toContain("socks");
    const all = (await call("boss", "GET", "/api/stores")).json.stores.map((s: StoreInfo) => s.id);
    expect(all).toEqual(expect.arrayContaining(["mugs-1", "socks"]));
  });

  it("hides another user's store completely, for reading and deleting", async () => {
    expect((await call("mia", "GET", "/api/stores/socks")).status).toBe(404);
    expect((await call("mia", "DELETE", "/api/stores/socks")).status).toBe(404);
    expect(prov.removed).not.toContain("socks");
  });

  it("reports status, URL and, once Ready, the tool prefix", async () => {
    prov.stores.get("mugs-1")!.phase = "Ready";
    prov.shops.set("mugs-1", { url: berlin.mcpUrl, token: berlin.token });
    await sync();
    const s = (await call("mia", "GET", "/api/stores/mugs-1")).json.store;
    expect(s).toMatchObject({ phase: "Ready", url: "http://mugs-1.stores.localtest.me", owned: true, registered: true, toolPrefix: "woo-mugs-1__" });
    expect(new Date(s.createdAt).getTime()).not.toBeNaN();
  });

  it("members do not learn that other users' store servers exist, and cannot delete a store server directly", async () => {
    const miaServers = (await call("mia", "GET", "/api/servers")).json.servers.map((x: { slug: string }) => x.slug);
    const samServers = (await call("sam", "GET", "/api/servers")).json.servers.map((x: { slug: string }) => x.slug);
    expect(miaServers).toContain("woo-mugs-1");
    expect(samServers).not.toContain("woo-mugs-1");
    const server = (await env.c.registry.getStoreServer("mugs-1"))!;
    expect((await call("sam", "GET", `/api/servers/${server.id}/tools`)).status).toBe(404);
    expect((await call("boss", "DELETE", `/api/servers/${server.id}`)).status).toBe(409);
  });

  it("deleting a store removes its tools straight away, and is audited", async () => {
    const res = await call("mia", "DELETE", "/api/stores/mugs-1");
    expect(res.status).toBe(202);
    expect(res.json.store.phase).toBe("Deleting");
    expect(await env.c.registry.getStoreServer("mugs-1")).toBeUndefined();
    const audit = await env.db.query("SELECT outcome FROM audit_log WHERE server_slug = 'stores' AND tool_name = 'delete_store'");
    expect(audit.rows[0]).toMatchObject({ outcome: "ok" });
  });

  it("reports an unreachable provisioner as a temporary failure, not a crash", async () => {
    prov.down = true;
    const res = await call("mia", "GET", "/api/stores");
    prov.down = false;
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe("stores_unavailable");
  });
});

describe("when multi-store provisioning is not configured", () => {
  it("answers the list with enabled=false and refuses to create", async () => {
    const plain = await createEnv();
    const plainApp = await buildApp(plain.c);
    await plain.c.auth.bootstrapAdmin("boss@example.com", "correct horse battery");
    const login = await plainApp.inject({ method: "POST", url: "/api/auth/login", payload: { email: "boss@example.com", password: "correct horse battery" }, headers: { "x-requested-with": "mcp-portal" } });
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    expect(JSON.parse((await plainApp.inject({ method: "GET", url: "/api/stores", headers: { cookie } })).body)).toEqual({ enabled: false, stores: [] });
    const create = await plainApp.inject({ method: "POST", url: "/api/stores", payload: { name: "x" }, headers: { cookie, "x-requested-with": "mcp-portal" } });
    expect(create.statusCode).toBe(404);
    await plainApp.close();
    await plain.cleanup();
  });
});
