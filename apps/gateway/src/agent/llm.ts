/**
 * Minimal OpenAI-compatible chat-completions client (works with Groq, OpenAI, Ollama, vLLM, ...).
 * Implemented on fetch with our own SSE parsing so there is no vendor SDK to pin or audit.
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string; // raw JSON string, exactly as the model produced it
  extra_content?: unknown; // Gemini thought_signature lives here; must be echoed back unchanged
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string }; extra_content?: unknown }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Sent as `reasoning_effort` when set (needed by some reasoning models to allow tool calls). */
  reasoningEffort?: string;
  timeoutMs: number;
}

export interface Completion {
  text: string;
  toolCalls: ToolCallRequest[];
  finishReason: string | null;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}


const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 15_000;

/** Seconds from a Retry-After header (or exponential backoff when absent), capped so a chat turn never stalls for long. */
export function retryDelayMs(header: string | null, attempt: number): number {
  const seconds = header ? Number(header) : NaN;
  const base = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000 * attempt;
  return Math.min(Math.max(base, 250), MAX_RETRY_WAIT_MS);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Streams one completion, calling `onText` for each text delta. Tool-call fragments are assembled. */
export async function complete(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: LlmTool[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Completion> {
  const timeout = AbortSignal.timeout(cfg.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  // Free-tier and shared LLM keys rate limit often. Wait out short limits (honouring Retry-After, capped) instead of
  // failing the whole chat turn; the overall timeout still bounds the total wait.
  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: 0.2, ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}), ...(tools.length ? { tools, tool_choice: "auto" } : {}) }),
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted) throw new LlmError("The language model did not respond in time");
      if (signal?.aborted) throw err;
      throw new LlmError(`Could not reach the language model: ${(err as Error).message}`);
    }
    if (res.status !== 429 || attempt === MAX_ATTEMPTS) break;
    const wait = retryDelayMs(res.headers.get("retry-after"), attempt);
    await res.text().catch(() => "");
    try {
      await sleep(wait, combined);
    } catch {
      if (timeout.aborted) throw new LlmError("The language model did not respond in time");
      throw new Error("aborted");
    }
  }
  if (!res) throw new LlmError("Could not reach the language model");

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new LlmError("The language model rejected the configured API key", res.status);
    if (res.status === 429) throw new LlmError("The language model is rate limiting requests. Try again in a moment.", res.status);
    throw new LlmError(`The language model returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }
  if (!res.body) throw new LlmError("The language model returned an empty response");

  let text = "";
  let finishReason: string | null = null;
  const calls = new Map<number, ToolCallRequest>();
  let nextExtra = 1_000_000;

  const handle = (data: string): void => {
    if (data === "[DONE]") return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // keep-alive or partial noise
    }
    if (chunk.error) throw new LlmError(String(chunk.error.message ?? "The language model reported an error"));
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      let index = typeof tc.index === "number" ? tc.index : 0;
      // Gemini's OpenAI-compatible endpoint omits `index` and sends each parallel call whole. A chunk that
      // names a call at a slot that already holds a finished call (it has a name and arguments, or another id)
      // starts a new call; gluing them together would join the names ("a" + "b" -> "ab").
      const held = calls.get(index);
      if (held && held.name && tc.function?.name && (held.arguments.length > 0 || (tc.id && tc.id !== held.id))) {
        index = nextExtra++;
      }
      const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) call.id = tc.id;
      if (tc.extra_content) call.extra_content = tc.extra_content;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
      calls.set(index, call);
    }
  };

  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    }
    if (buffer.startsWith("data:")) handle(buffer.slice(5).trim());
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (timeout.aborted) throw new LlmError("The language model did not respond in time");
    if (signal?.aborted) throw err;
    throw new LlmError(`The language model connection dropped: ${(err as Error).message}`);
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c], i) => ({ ...c, id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}` }))
    .filter((c) => c.name);
  return { text, toolCalls, finishReason };
}