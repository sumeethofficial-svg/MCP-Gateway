import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runAgent, type AgentEvent } from "../../agent/agent.js";
import { LlmError, type ChatMessage } from "../../agent/llm.js";
import type { Container } from "../../container.js";
import { notFound, tooMany } from "../../errors.js";
import { RateLimiter } from "../../util/rate-limiter.js";
import { me, parse, requireUser } from "../support.js";

const idParam = z.object({ id: z.string().uuid() });
const MAX_STORED_MESSAGES = 200;
const MAX_HISTORY_MESSAGES = 40;

/** Keeps the tail of a conversation for the model, never starting on an orphaned tool result. */
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const tail = messages.slice(-MAX_HISTORY_MESSAGES);
  const firstUser = tail.findIndex((m) => m.role === "user");
  return firstUser < 0 ? [] : tail.slice(firstUser);
}

export function chatRoutes(app: FastifyInstance, c: Container, fetchImpl?: typeof fetch): void {
  const user = requireUser(c);
  const runLimiter = new RateLimiter(12, 60_000);

  app.get("/api/chat/status", { preHandler: user }, async () => ({ configured: !!c.config.llm.apiKey, model: c.config.llm.model }));

  app.get("/api/conversations", { preHandler: user }, async (req) => {
    const { rows } = await c.db.query(
      "SELECT id, title, updated_at AS \"updatedAt\" FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100",
      [me(req).userId],
    );
    return { conversations: rows };
  });

  app.get("/api/conversations/:id", { preHandler: user }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { rows } = await c.db.query("SELECT id, title, messages, updated_at AS \"updatedAt\" FROM conversations WHERE id = $1 AND user_id = $2", [id, me(req).userId]);
    if (!rows[0]) throw notFound("Conversation not found");
    return { conversation: rows[0] };
  });

  app.delete("/api/conversations/:id", { preHandler: user }, async (req) => {
    const { id } = parse(idParam, req.params);
    await c.db.query("DELETE FROM conversations WHERE id = $1 AND user_id = $2", [id, me(req).userId]);
    return { ok: true };
  });

  app.post("/api/chat", { preHandler: user }, async (req, reply) => {
    const principal = { ...me(req), via: "chat" as const };
    const body = parse(z.object({ conversationId: z.string().uuid().optional(), message: z.string().trim().min(1).max(4000) }), req.body);

    const decision = runLimiter.consume(`chat:${principal.userId}`);
    if (!decision.allowed) throw tooMany("You are sending messages too quickly. Wait a few seconds.", decision.retryAfterMs);

    let conversationId = body.conversationId;
    let history: ChatMessage[] = [];
    if (conversationId) {
      const { rows } = await c.db.query<{ messages: ChatMessage[] }>("SELECT messages FROM conversations WHERE id = $1 AND user_id = $2", [conversationId, principal.userId]);
      if (!rows[0]) throw notFound("Conversation not found");
      history = rows[0].messages;
    } else {
      const title = body.message.replace(/\s+/g, " ").slice(0, 60);
      const { rows } = await c.db.query<{ id: string }>("INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id", [principal.userId, title]);
      conversationId = rows[0]!.id;
    }

    // From here on we stream Server-Sent Events; errors become `error` events rather than HTTP statuses.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (e: AgentEvent | { type: "conversation"; id: string }) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    send({ type: "conversation", id: conversationId });

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    let stored: ChatMessage[] | undefined;
    let outcome = "ok";
    try {
      const result = await runAgent(
        { gateway: c.gateway, config: c.config, fetchImpl },
        principal,
        trimHistory(history),
        body.message,
        send,
        { requestId: req.id, signal: abort.signal },
      );
      stored = [...history, ...result.messages.slice(trimHistory(history).length)];
    } catch (err) {
      const partial = (err as { partial?: ChatMessage[] }).partial;
      if (partial) stored = [...history, ...partial.slice(trimHistory(history).length)];
      if (abort.signal.aborted) {
        outcome = "aborted";
      } else if (err instanceof LlmError) {
        outcome = "llm_error";
        send({ type: "error", message: err.message });
      } else {
        outcome = "error";
        c.log.error({ err: (err as Error).message, reqId: req.id }, "chat run failed");
        send({ type: "error", message: "The assistant hit an unexpected error." });
      }
    }

    c.metrics.chatRuns.inc({ outcome });
    if (stored) {
      await c.db
        .query("UPDATE conversations SET messages = $3::jsonb, updated_at = now() WHERE id = $1 AND user_id = $2", [conversationId, principal.userId, JSON.stringify(stored.slice(-MAX_STORED_MESSAGES))])
        .catch((err) => c.log.error({ err: err.message }, "failed to save conversation"));
    }
    if (!res.writableEnded) res.end();
  });
}
