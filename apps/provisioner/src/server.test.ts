import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { StoreManager } from "./manager.js";
import { createApi } from "./server.js";
import { FakeHelm, FakeKube } from "./testing.js";

const TOKEN = "x".repeat(40);

describe("provisioner API", () => {
  const kube = new FakeKube();
  const helm = new FakeHelm();
  const config = loadConfig({ PROVISIONER_TOKEN: TOKEN, WORK_DIR: mkdtempSync(path.join(tmpdir(), "prov-api-")) });
  const manager = new StoreManager(kube, helm, config, pino({ level: "silent" }));
  const server = createApi(manager, TOKEN, pino({ level: "silent" }));
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await manager.stop();
    server.close();
  });

  const call = (method: string, p: string, body?: unknown, token: string | null = TOKEN) =>
    fetch(base + p, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("serves health without a token and everything else only with the right one", async () => {
    expect((await call("GET", "/healthz", undefined, null)).status).toBe(200);
    expect((await call("GET", "/stores", undefined, null)).status).toBe(401);
    expect((await call("GET", "/stores", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/stores")).status).toBe(200);
    expect((await call("GET", "/nope")).status).toBe(404);
  });

  it("creates, lists, reads and deletes a store", async () => {
    const create = await call("POST", "/stores", { id: "berlin", name: "Berlin Store", ownerId: "u-1", ownerEmail: "a@example.com" });
    expect(create.status).toBe(201);
    expect(((await create.json()) as { store: { phase: string } }).store.phase).toBe("Provisioning");

    const again = await call("POST", "/stores", { id: "berlin", name: "Berlin Store", ownerId: "u-1" });
    expect(again.status).toBe(200);

    const list = (await (await call("GET", "/stores?owner=u-1")).json()) as { stores: { id: string }[] };
    expect(list.stores.map((s) => s.id)).toEqual(["berlin"]);
    expect(((await (await call("GET", "/stores?owner=u-2")).json()) as { stores: unknown[] }).stores).toEqual([]);
    expect((await call("GET", "/stores/berlin")).status).toBe(200);
    expect((await call("GET", "/stores/berlin/mcp")).status).toBe(409);

    const del = await call("DELETE", "/stores/berlin");
    expect(del.status).toBe(202);
    await manager.idle();
    expect((await call("GET", "/stores/berlin")).status).toBe(404);
  });

  it("returns clear errors for bad input", async () => {
    const bad = await call("POST", "/stores", { id: "Bad Id", name: "x", ownerId: "u-1" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_id");
    expect((await call("POST", "/stores", { nope: true })).status).toBe(400);
    expect((await call("DELETE", "/stores/ghost")).status).toBe(404);
  });
});

describe("configuration", () => {
  it("requires a long token and a sane prefix", () => {
    expect(() => loadConfig({ PROVISIONER_TOKEN: "short" })).toThrow(/at least 24/);
    expect(() => loadConfig({ PROVISIONER_TOKEN: TOKEN, STORE_NS_PREFIX: "store" })).toThrow(/hyphen/);
    expect(() => loadConfig({ PROVISIONER_TOKEN: TOKEN, STORE_VALUES_JSON: "[1]" })).toThrow(/JSON object/);
    expect(loadConfig({ PROVISIONER_TOKEN: TOKEN }).maxPerUser).toBe(3);
  });
});
