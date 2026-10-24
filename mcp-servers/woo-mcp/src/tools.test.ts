import type { AddressInfo } from "node:net";
import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer } from "@mcp-portal/mcp-kit";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeOrder, MOCK_KEY, MOCK_SECRET, startMockWoo, type MockWoo } from "./testing.js";
import { registerWooTools } from "./tools.js";
import { WooClient } from "./woo-client.js";

const TOKEN = "gateway-token";
let woo: MockWoo;
let server: http.Server;
let mcpUrl: string;

beforeAll(async () => {
  woo = await startMockWoo();
  const log = pino({ level: "silent" });
  const config = { timezone: "Asia/Kolkata", storeName: "demo-store" };
  const client = new WooClient({ baseUrl: woo.url, consumerKey: MOCK_KEY, consumerSecret: MOCK_SECRET, timeoutMs: 1000 });
  server = createMcpHttpServer({
    name: "woo-mcp",
    version: "test",
    authToken: TOKEN,
    logger: log,
    ready: () => client.reachable(),
    registerTools: (s) => registerWooTools(s, client, config, log),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await woo.close();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  woo.products.length = 0;
  woo.orders.length = 0;
  woo.requests.length = 0;
  woo.failNext(0, 503);
  woo.hang(false);
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as any, text: (res.content as { text: string }[])[0]?.text ?? "" };
}

describe("woo-mcp tools", () => {
  it("exposes the required tools with correct read/write annotations", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const required of ["list_products", "create_product", "remove_product", "list_orders", "get_order", "update_order_status"]) {
      expect(byName.has(required), required).toBe(true);
    }
    expect(byName.get("list_orders")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("create_product")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("update_order_status")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("remove_product")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("remove_product")?.annotations?.destructiveHint).toBe(true);
    await client.close();
  });

  it("creates a product and lists it back", async () => {
    const client = await connect();
    const created = await call(client, "create_product", { name: "Filter Coffee 250g", regular_price: 349 });
    expect(created.isError).toBe(false);
    expect(created.data.product).toMatchObject({ name: "Filter Coffee 250g", regular_price: "349", status: "publish" });
    expect(woo.requests.at(-1)?.body).toMatchObject({ type: "simple", status: "publish", regular_price: "349" });

    const listed = await call(client, "list_products", { search: "coffee" });
    expect(listed.data.products).toHaveLength(1);
    expect(listed.data.store).toBe("demo-store");
    await client.close();
  });

  it("rejects invalid prices before they reach WooCommerce", async () => {
    const client = await connect();
    for (const bad of ["-5", "abc", "1.999", "", "1e3"]) {
      const res = await client.callTool({ name: "create_product", arguments: { name: "X", regular_price: bad } }).catch(() => ({ isError: true }));
      expect(res.isError, `price ${bad}`).toBe(true);
    }
    expect(woo.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    await client.close();
  });
  it("removes a product by ID: trash by default, permanent only when asked", async () => {
    const client = await connect();
    const a = (await call(client, "create_product", { name: "Seiko 5", regular_price: 7999 })).data.product.id;
    const b = (await call(client, "create_product", { name: "Seiko 5 duplicate", regular_price: 7999 })).data.product.id;

    const trashed = await call(client, "remove_product", { id: a });
    expect(trashed.isError).toBe(false);
    expect(trashed.data).toMatchObject({ removed: true, permanent: false });
    expect(woo.requests.at(-1)).toMatchObject({ method: "DELETE", route: `/wc/v3/products/${a}` });
    expect(woo.requests.at(-1)?.query.get("force")).toBe("false");
    expect(woo.products.find((p) => p.id === a)?.status).toBe("trash");
    expect((await call(client, "list_products")).data.products.map((p: { id: number }) => p.id)).toEqual([b]);

    const gone = await call(client, "remove_product", { id: b, permanent: true });
    expect(gone.data).toMatchObject({ removed: true, permanent: true });
    expect(woo.requests.at(-1)?.query.get("force")).toBe("true");
    expect(woo.products.find((p) => p.id === b)).toBeUndefined();
    await client.close();
  });

  it("reports a clean error when removing a product that does not exist", async () => {
    const client = await connect();
    const res = await call(client, "remove_product", { id: 9999 });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Invalid ID.");
    await client.close();
  });

  it("lists today's orders using the store's calendar and hides customer data by default", async () => {
    const now = Date.now();
    const iso = (offsetHours: number) => new Date(now + offsetHours * 3_600_000).toISOString().replace("Z", "").replace(/\.\d+$/, "");
    woo.orders.push(
      makeOrder(1, { date_created_gmt: iso(0) }), // now: inside "today"
      makeOrder(2, { date_created_gmt: iso(-72) }), // three days ago
    );
    const client = await connect();
    const res = await call(client, "list_orders", { date_preset: "today" });
    expect(res.isError).toBe(false);
    expect(res.data.orders.map((o: { id: number }) => o.id)).toEqual([1]);
    expect(res.data.window).toMatch(/\(Asia\/Kolkata\)$/);

    // Privacy by default, and the injection-prone free-text note is never returned.
    expect(res.data.orders[0].customer).toBeUndefined();
    expect(res.text).not.toContain("asha@example.com");
    expect(res.text).not.toContain("attacker@example.com");

    const withCustomer = await call(client, "list_orders", { date_preset: "today", include_customer_details: true });
    expect(withCustomer.data.orders[0].customer).toMatchObject({ name: "Asha Rao", email: "asha@example.com" });
    expect(withCustomer.text).not.toContain("attacker@example.com");
    await client.close();
  });

  it("rejects mixing date_preset with explicit bounds", async () => {
    const client = await connect();
    const res = await call(client, "list_orders", { date_preset: "today", after: "2026-01-01T00:00:00Z" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/either date_preset or after\/before/);
    await client.close();
  });

  it("gets an order and reports a clean error for a missing one", async () => {
    woo.orders.push(makeOrder(7, { total: "249.50" }));
    const client = await connect();
    expect((await call(client, "get_order", { id: 7 })).data.order).toMatchObject({ id: 7, total: "249.50", item_count: 1 });
    const missing = await call(client, "get_order", { id: 404 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("Invalid ID.");
    await client.close();
  });

  it("updates order status and records an optional note", async () => {
    woo.orders.push(makeOrder(9));
    const client = await connect();
    const res = await call(client, "update_order_status", { id: 9, status: "completed", note: "Shipped via courier" });
    expect(res.data.order.status).toBe("completed");
    expect(woo.requests.map((r) => `${r.method} ${r.route}`)).toEqual(
      expect.arrayContaining(["PUT /wc/v3/orders/9", "POST /wc/v3/orders/9/notes"]),
    );
    const invalid = await client.callTool({ name: "update_order_status", arguments: { id: 9, status: "teleported" } }).catch(() => ({ isError: true }));
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it("summarises sales: revenue counts only real-revenue statuses, in exact minor units", async () => {
    const t = new Date().toISOString().replace("Z", "").replace(/\.\d+$/, "");
    woo.orders.push(
      makeOrder(1, { date_created_gmt: t, total: "100.10", status: "processing" }),
      makeOrder(2, { date_created_gmt: t, total: "200.20", status: "completed" }),
      makeOrder(3, { date_created_gmt: t, total: "999.00", status: "cancelled" }),
      makeOrder(4, { date_created_gmt: t, total: "50.00", status: "pending" }),
    );
    const client = await connect();
    const res = await call(client, "sales_summary", { date_preset: "today" });
    expect(res.data).toMatchObject({
      store: "demo-store",
      order_count: 4,
      revenue: "300.30",
      currency: "INR",
      by_status: { processing: 1, completed: 1, cancelled: 1, pending: 1 },
      truncated: false,
    });
    await client.close();
  });

  it("surfaces store outages as tool errors without leaking internals", async () => {
    woo.failNext(5, 503);
    const client = await connect();
    const res = await call(client, "list_products");
    expect(res.isError).toBe(true);
    expect(res.text).toBe("WooCommerce is unavailable (HTTP 503).");
    await client.close();
  });

  it("reports readiness only when the store answers", async () => {
    const base = mcpUrl.replace("/mcp", "");
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    woo.failNext(5, 503);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });
});
