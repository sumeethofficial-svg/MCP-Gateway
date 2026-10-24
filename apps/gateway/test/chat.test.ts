import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/agent/llm.js";
import { buildApp } from "../src/http/app.js";
import { createEnv, startCurrency, startKubeOps, type TestEnv, type TestUpstream } from "./harness.js";

let env: TestEnv;
let app: FastifyInstance;
let ops: TestUpstream;
let currency: TestUpstream;
let adminCookie: string;
let memberCookie: string;

/** A scripted OpenAI-compatible endpoint: each call pops the next reply and records what it was sent. */
type Reply = { text?: string; tool?: { name: string; args: unknown } };
let script: Reply[] = [];
let seen: { messages: ChatMessage[]; tools: { function: { name: string } }[] }[] = [];

const fakeLlm: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  seen.push({ messages: body.messages, tools: body.tools ?? [] });
  const next = script.shift() ?? { text: "(script exhausted)" };
  const chunks: unknown[] = [];
  if (next.text) for (const word of next.text.match(/\S+\s*/g) ?? []) chunks.push({ choices: [{ delta: { content: word } }] });
  if (next.tool) {
    const raw = typeof next.tool.args === "string" ? next.tool.args : JSON.stringify(next.tool.args);
    // split across fragments like a real provider does
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: next.tool.name, arguments: raw.slice(0, 3) } }] } }] });
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(3) } }] } }] });
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: next.tool ? "tool_calls" : "stop" }] });
  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};

async function chat(cookie: string, message: string, conversationId?: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { cookie, "x-requested-with": "mcp-portal" },
    payload: { message, conversationId },
  });
  const events = res.body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  return { status: res.statusCode, events };
}

async function login(email: string, password: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-requested-with": "mcp-portal" }, payload: { email, password } });
  return `${r.cookies[0]!.name}=${r.cookies[0]!.value}`;
}

beforeAll(async () => {
  env = await createEnv({ LLM_API_KEY: "test-key", AGENT_MAX_STEPS: "4", LAZY_TOOLS_THRESHOLD: "100" });
  ops = await startKubeOps();
  currency = await startCurrency();
  await env.addUpstream(ops, "kube-ops");
  await env.addUpstream(currency, "currency");
  await env.c.auth.bootstrapAdmin("boss@example.com", "correct horse battery");
  const { token } = await env.c.auth.createInvite(
    (await env.c.auth.listUsers()).map((u) => ({ userId: u.id, email: u.email, name: u.name, role: u.role, via: "api_key" as const }))[0]!,
    "mia@example.com",
    "member",
  );
  await env.c.auth.acceptInvite(token, { name: "Mia", password: "a long password 123" });
  app = await buildApp(env.c, { llmFetch: fakeLlm });
  adminCookie = await login("boss@example.com", "correct horse battery");
  memberCookie = await login("mia@example.com", "a long password 123");
});

afterAll(async () => {
  await app.close();
  await Promise.all([ops.close(), currency.close()]);
  await env.cleanup();
});

describe("chat agent", () => {
  it("calls a tool as the user, streams the call and result, and answers", async () => {
    seen = [];
    script = [{ tool: { name: "kube-ops__list_pods", args: { namespace: "platform" } } }, { text: "Three pods run in platform; one is crash looping." }];
    const { events } = await chat(adminCookie, "what is running in platform?");
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types.at(-1)).toBe("done");
    const call = events.find((e) => e.type === "tool_call");
    expect(call.name).toBe("kube-ops__list_pods");
    expect(call.arguments).toEqual({ namespace: "platform" }); // fragments reassembled
    expect(events.find((e) => e.type === "tool_result"), JSON.stringify(events)).toMatchObject({ ok: true });
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toContain("crash looping");

    // the second model call saw the tool result
    expect(seen[1]!.messages.some((m) => m.role === "tool")).toBe(true);
    // and the call was audited as a chat call by the admin
    const audit = await env.c.audit.query({ tool: "list_pods" });
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it("enforces the user's permissions: a denied tool is reported, not performed", async () => {
    await env.c.policy.create({ subjectType: "role", subject: "member", serverSlug: "currency", toolName: "*", effect: "deny" }, (await env.c.auth.listUsers())[0]!.id);
    seen = [];
    script = [{ tool: { name: "currency__convert_currency", args: { amount: 5, from: "USD", to: "INR" } } }, { text: "I am not allowed to do that." }];
    const { events } = await chat(memberCookie, "convert 5 dollars to rupees");
    const result = events.find((e) => e.type === "tool_result");
    expect(result.ok).toBe(false);
    // the denied tool was never even offered to the model
    expect(seen[0]!.tools.some((t) => t.function.name.startsWith("currency__"))).toBe(false);
  });

  it("persists the conversation and gives the model its history on the next turn", async () => {
    script = [{ text: "Hello Mia." }];
    const first = await chat(memberCookie, "hi");
    const id = first.events.find((e) => e.type === "conversation").id;
    seen = [];
    script = [{ text: "You said hi." }];
    await chat(memberCookie, "what did I say?", id);
    expect(seen[0]!.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["hi", "what did I say?"]);
    const list = await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: memberCookie } });
    expect(JSON.parse(list.body).conversations.length).toBeGreaterThan(0);
    // another user cannot open it
    const other = await app.inject({ method: "GET", url: `/api/conversations/${id}`, headers: { cookie: adminCookie } });
    expect(other.statusCode).toBe(404);
  });

  it("stops at the step limit instead of looping forever", async () => {
    script = Array.from({ length: 10 }, () => ({ tool: { name: "kube-ops__list_pods", args: { namespace: "store" } } }));
    const { events } = await chat(adminCookie, "loop");
    expect(events.filter((e) => e.type === "tool_call").length).toBe(4);
    expect(events.at(-1).type).toBe("done");
  });

  it("recovers from malformed tool arguments by telling the model", async () => {
    seen = [];
    script = [{ tool: { name: "kube-ops__list_pods", args: "{not json" } }, { text: "Sorry." }];
    const { events } = await chat(adminCookie, "bad args");
    expect(events.find((e) => e.type === "tool_result").ok).toBe(false);
    expect(events.at(-1).type).toBe("done");
  });

  it("switches to lazy mode above the tool threshold", async () => {
    const lazy = await createEnv({ LLM_API_KEY: "k", LAZY_TOOLS_THRESHOLD: "2" });
    const f = await startKubeOps();
    try {
      await lazy.addUpstream(f, "kube-ops");
      const p = await lazy.makeUser("admin");
      const { runAgent } = await import("../src/agent/agent.js");
      seen = [];
      script = [{ text: "ok" }];
      const events: any[] = [];
      await runAgent({ gateway: lazy.c.gateway, config: lazy.c.config, fetchImpl: fakeLlm }, p, [], "hello", (e) => events.push(e), { requestId: "t" });
      expect(events[0]).toMatchObject({ type: "mode", mode: "lazy" });
      expect(seen[0]!.tools.map((t) => t.function.name).sort()).toEqual(["gateway__call_tool", "gateway__describe_tool", "gateway__search_tools"]);
    } finally {
      await f.close();
      await lazy.cleanup();
    }
  });

  it("reports a missing API key clearly", async () => {
    const bare = await createEnv({});
    try {
      const p = await bare.makeUser("admin");
      const { runAgent } = await import("../src/agent/agent.js");
      await expect(runAgent({ gateway: bare.c.gateway, config: bare.c.config }, p, [], "hi", () => {}, { requestId: "t" })).rejects.toThrow(/LLM_API_KEY/);
    } finally {
      await bare.cleanup();
    }
  });
});
