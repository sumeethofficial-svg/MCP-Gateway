import { describe, expect, it } from "vitest";
import { WooClient } from "./woo-client.js";

const client = (status: number | Error) =>
  new WooClient({ baseUrl: "http://wp", consumerKey: "ck", consumerSecret: "cs", timeoutMs: 500 }, (async () => {
    if (status instanceof Error) throw status;
    return new Response(null, { status });
  }) as typeof fetch);

describe("readiness (reachable)", () => {
  it("is ready when WordPress redirects to its installer, so a fresh install can finish provisioning", async () => {
    await expect(client(302).reachable()).resolves.toBeUndefined();
  });
  it("is ready on 200 and on 401, because credentials are not part of readiness", async () => {
    await expect(client(200).reachable()).resolves.toBeUndefined();
    await expect(client(401).reachable()).resolves.toBeUndefined();
  });
  it("is not ready on gateway errors or when the connection fails", async () => {
    await expect(client(503).reachable()).rejects.toThrow(/unavailable/i);
    await expect(client(new TypeError("fetch failed")).reachable()).rejects.toThrow();
  });
});
