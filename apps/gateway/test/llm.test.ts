import { describe, expect, it } from "vitest";
import { complete, LlmError, retryDelayMs } from "../src/agent/llm.js";

const cfg = { baseUrl: "http://llm.test", model: "m", timeoutMs: 5000 };
const sse = (text: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

describe("llm client rate limiting", () => {
  it("waits out a 429 and then succeeds", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return calls === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : sse("hello");
    };
    const out = await complete(cfg, [{ role: "user", content: "hi" }], [], () => {}, undefined, fetchImpl);
    expect(out.text).toBe("hello");
    expect(calls).toBe(2);
  });

  it("gives up with a friendly error after repeated 429s", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    };
    const err = await complete(cfg, [{ role: "user", content: "hi" }], [], () => {}, undefined, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).status).toBe(429);
    expect(calls).toBe(3);
  });

  it("caps long Retry-After values and backs off when the header is missing", () => {
    expect(retryDelayMs("120", 1)).toBe(15_000);
    expect(retryDelayMs(null, 2)).toBe(4000);
    expect(retryDelayMs("0", 1)).toBe(250);
  });
});

describe("llm client request body", () => {
  it("sends reasoning_effort only when configured", async () => {
    const bodies: any[] = [];
    const fetchImpl: typeof fetch = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse("ok");
    };
    await complete(cfg, [{ role: "user", content: "hi" }], [], () => {}, undefined, fetchImpl);
    await complete({ ...cfg, reasoningEffort: "none" }, [{ role: "user", content: "hi" }], [], () => {}, undefined, fetchImpl);
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1].reasoning_effort).toBe("none");
  });
});

describe("llm client parallel tool calls", () => {
  const stream = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: c }] })}\n\n`).join("") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  it("keeps parallel calls apart when the provider sends no index (Gemini)", async () => {
    const fetchImpl: typeof fetch = async () =>
      stream([
        { tool_calls: [{ id: "", function: { name: "currency__get_exchange_rate", arguments: '{"from":"USD","to":"INR"}' } }] },
        { tool_calls: [{ id: "", function: { name: "currency__convert_currency", arguments: '{"amount":1}' } }] },
        { tool_calls: [{ id: "", function: { name: "woo__list_products", arguments: "{}" } }] },
      ]);
    const out = await complete(cfg, [{ role: "user", content: "hi" }], [], () => {}, undefined, fetchImpl);
    expect(out.toolCalls.map((c) => c.name)).toEqual(["currency__get_exchange_rate", "currency__convert_currency", "woo__list_products"]);
    expect(out.toolCalls.map((c) => c.arguments)).toEqual(['{"from":"USD","to":"INR"}', '{"amount":1}', "{}"]);
  });

  it("still assembles one call streamed in pieces by index (OpenAI)", async () => {
    const fetchImpl: typeof fetch = async () =>
      stream([
        { tool_calls: [{ index: 0, id: "call_a", function: { name: "woo__list_products", arguments: "" } }] },
        { tool_calls: [{ index: 0, function: { arguments: '{"per_' } }] },
        { tool_calls: [{ index: 0, function: { arguments: 'page":5}' } }] },
        { tool_calls: [{ index: 1, id: "call_b", function: { name: "currency__convert_currency", arguments: '{"amount":2}' } }] },
      ]);
    const out = await complete(cfg, [{ role: "user", content: "hi" }], [], () => {}, undefined, fetchImpl);
    expect(out.toolCalls.map((c) => [c.id, c.name, c.arguments])).toEqual([
      ["call_a", "woo__list_products", '{"per_page":5}'],
      ["call_b", "currency__convert_currency", '{"amount":2}'],
    ]);
  });
});