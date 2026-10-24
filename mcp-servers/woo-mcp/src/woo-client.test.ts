import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MOCK_KEY, MOCK_SECRET, startMockWoo, type MockWoo } from "./testing.js";
import { WooClient, WooError } from "./woo-client.js";

let woo: MockWoo;

beforeAll(async () => {
  woo = await startMockWoo();
});
afterAll(() => woo.close());
beforeEach(() => {
  woo.requests.length = 0;
  woo.failNext(0, 503);
  woo.hang(false);
});

const client = (overrides: Partial<ConstructorParameters<typeof WooClient>[0]> = {}) =>
  new WooClient({ baseUrl: woo.url, consumerKey: MOCK_KEY, consumerSecret: MOCK_SECRET, timeoutMs: 500, ...overrides });

describe("WooClient", () => {
  it("authenticates and addresses the API under /wp-json (the only form WooCommerce authenticates)", async () => {
    await client().get("/products", { query: { per_page: 1 } });
    expect(woo.requests[0]).toMatchObject({ method: "GET", route: "/wc/v3/products" });
  });

  it("maps bad credentials to an auth error without leaking the secret", async () => {
    const err = await client({ consumerSecret: "wrong-secret" }).get("/products").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WooError);
    expect((err as WooError).kind).toBe("auth");
    expect((err as WooError).message).not.toContain("wrong-secret");
    expect((err as WooError).message).not.toContain(MOCK_KEY);
  });

  it("maps 404 and validation errors", async () => {
    expect(await client().get("/products/99999").catch((e: WooError) => e.kind)).toBe("not_found");
    expect(await client().post("/products", {}).catch((e: WooError) => e.kind)).toBe("validation");
  });

  it("retries an idempotent GET once on 503 and then succeeds", async () => {
    woo.failNext(1, 503);
    await expect(client().get("/products")).resolves.toBeDefined();
    expect(woo.requests).toHaveLength(2);
  });

  it("does not retry writes (avoids duplicate products)", async () => {
    woo.failNext(1, 503);
    const kind = await client().post("/products", { name: "X", regular_price: "1" }).catch((e: WooError) => e.kind);
    expect(kind).toBe("unavailable");
    expect(woo.requests).toHaveLength(1);
  });

  it("gives up after the retry and reports unavailable", async () => {
    woo.failNext(5, 502);
    expect(await client().get("/products").catch((e: WooError) => e.kind)).toBe("unavailable");
  });

  it("times out instead of hanging", async () => {
    woo.hang(true);
    const started = Date.now();
    const kind = await client({ timeoutMs: 150 }).get("/products").catch((e: WooError) => e.kind);
    expect(kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("reports an unreachable host", async () => {
    const kind = await client({ baseUrl: "http://127.0.0.1:1" }).get("/products").catch((e: WooError) => e.kind);
    expect(kind).toBe("unavailable");
  });
});
