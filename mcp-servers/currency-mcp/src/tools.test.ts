import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AS_OF, convert, EARLIEST, rateAt } from "./rates.js";
import { registerCurrencyTools } from "./tools.js";

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "currency", version: "0" });
  registerCurrencyTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

describe("rate math", () => {
  it("is consistent in both directions", () => {
    expect(rateAt("USD", "INR").rate).toBeCloseTo(94.96, 6);
    expect(rateAt("INR", "USD").rate * rateAt("USD", "INR").rate).toBeCloseTo(1, 10);
  });
  it("rounds to the target currency's precision", () => {
    expect(convert(100, "USD", "JPY").result).toBe(15800);
    expect(convert(100, "USD", "INR").result).toBe(9496);
    expect(convert(1, "INR", "USD").result).toBe(0.01);
  });
  it("history ends at today's table and moves for volatile pairs", () => {
    expect(rateAt("USD", "INR", AS_OF).rate).toBeCloseTo(rateAt("USD", "INR").rate, 10);
    expect(rateAt("USD", "JPY", EARLIEST).rate).not.toBeCloseTo(rateAt("USD", "JPY").rate, 2);
    expect(rateAt("USD", "AED", EARLIEST).rate).toBeCloseTo(3.6725, 6); // pegged: no drift
  });
});

describe("currency-mcp tools", () => {
  it("lists exactly the documented tools, all read-only", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["convert_currency", "get_exchange_rate", "get_historical_rate", "list_currencies"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });
  it("converts and says the data is indicative sample data", async () => {
    const res = await (await connect()).callTool({ name: "convert_currency", arguments: { amount: 9496, from: "inr", to: "USD" } });
    expect(res.structuredContent).toMatchObject({ from: "INR", to: "USD", result: 100, source: "sample", indicative: true });
  });
  it("returns the current rate", async () => {
    const res = await (await connect()).callTool({ name: "get_exchange_rate", arguments: { from: "USD", to: "INR" } });
    expect(res.structuredContent).toMatchObject({ rate: 94.96, as_of: AS_OF });
  });
  it("returns a monthly snapshot for a historical date", async () => {
    const res = await (await connect()).callTool({ name: "get_historical_rate", arguments: { from: "USD", to: "JPY", date: "2026-04-15" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ date: "2026-04-15", snapshot: "2026-04", source: "sample" });
  });
  it.each([
    ["unknown currency", { from: "XXX", to: "USD" }, "get_exchange_rate"],
    ["bad date", { from: "USD", to: "INR", date: "2026-02-31" }, "get_historical_rate"],
    ["too late", { from: "USD", to: "INR", date: "2027-01-01" }, "get_historical_rate"],
    ["too early", { from: "USD", to: "INR", date: "2019-01-01" }, "get_historical_rate"],
  ])("reports %s as a tool error", async (_label, args, name) => {
    const res = await (await connect()).callTool({ name, arguments: args });
    expect(res.isError).toBe(true);
  });
});