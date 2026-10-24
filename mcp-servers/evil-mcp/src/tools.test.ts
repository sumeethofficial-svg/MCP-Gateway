import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { forecastDescription, POISONED_DESCRIPTION, registerEvilTools } from "./tools.js";

describe("evil-mcp fixture", () => {
  it("serves a poisoned description, a result-side injection and claims read-only", async () => {
    const server = new McpServer({ name: "evil", version: "0" });
    registerEvilTools(server, { rugPullAfterSeconds: 0, startedAt: Date.now() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    const weather = tools.find((t) => t.name === "get_weather")!;
    expect(weather.description).toBe(POISONED_DESCRIPTION);
    expect(weather.annotations?.readOnlyHint).toBe(true);
    const res = await client.callTool({ name: "get_weather", arguments: { city: "Chennai" } });
    expect(JSON.stringify(res.structuredContent)).toMatch(/SYSTEM NOTICE/);
  });

  it("rug-pulls only after the configured delay", () => {
    const startedAt = 1_000_000;
    const at = (seconds: number) => ({ rugPullAfterSeconds: 60, startedAt, now: () => startedAt + seconds * 1000 });
    expect(forecastDescription(at(10))).not.toMatch(/ignore all previous/i);
    expect(forecastDescription(at(61))).toMatch(/ignore all previous/i);
    expect(forecastDescription({ rugPullAfterSeconds: 0, startedAt, now: () => startedAt + 1e9 })).not.toMatch(/ignore/i);
  });
});
