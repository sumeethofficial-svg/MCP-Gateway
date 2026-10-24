import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MessageSquarePlus, SendHorizontal, Trash2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, ErrorNote, Panel, Spinner, ToolName, cx } from "../components/ui";
import { ApiError, del, get } from "../lib/api";
import { ms } from "../lib/format";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; args: unknown; ok?: boolean; result?: string; ms?: number; truncated?: boolean }
  | { kind: "note"; text: string };

interface Stored { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }

function fromStored(messages: Stored[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") items.push({ kind: "user", text: m.content ?? "" });
    else if (m.role === "assistant") {
      if (m.content) items.push({ kind: "assistant", text: m.content });
      for (const c of m.tool_calls ?? []) {
        let args: unknown = c.function.arguments;
        try { args = JSON.parse(c.function.arguments); } catch { /* keep raw text */ }
        items.push({ kind: "tool", id: c.id, name: c.function.name, args });
      }
    } else if (m.role === "tool") {
      const t = items.find((i) => i.kind === "tool" && i.id === m.tool_call_id);
      if (t && t.kind === "tool") { t.result = m.content ?? ""; t.ok = !/^(MCP error|Error|Permission|You do not have|Denied|.*is not available)/i.test(t.result); }
    }
  }
  return items;
}

const suggestions = [
  "Is everything healthy in the platform?",
  "Why is any server unreachable, and how would I fix it?",
  "What orders came in today, and what's their status?",
  "List the products in my stores",
  "Convert 250 USD to INR",
  "Which of my tools can change data?",
];

export function Chat() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["chat-status"], queryFn: () => get<{ configured: boolean; model: string }>("/api/chat/status") });
  const convs = useQuery({ queryKey: ["conversations"], queryFn: () => get<{ conversations: { id: string; title: string }[] }>("/api/conversations") });
  const [id, setId] = useState<string>();
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController>();

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [items]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const open = async (cid: string) => {
    setId(cid); setError(undefined);
    const r = await get<{ conversation: { messages: Stored[] } }>(`/api/conversations/${cid}`);
    setItems(fromStored(r.conversation.messages));
  };
  const fresh = () => { abortRef.current?.abort(); setId(undefined); setItems([]); setError(undefined); setBusy(false); };

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setInput(""); setError(undefined); setBusy(true);
    setItems((p) => [...p, { kind: "user", text }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/chat", {
        method: "POST", credentials: "same-origin", signal: ctrl.signal,
        headers: { "content-type": "application/json", "x-requested-with": "mcp-portal" },
        body: JSON.stringify({ message: text, conversationId: id }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => undefined);
        throw new ApiError(res.status, "chat", j?.error?.message ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (line.startsWith("data:")) apply(JSON.parse(line.slice(5)));
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : "The assistant failed");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  }

  function apply(e: any) {
    switch (e.type) {
      case "conversation": setId(e.id); break;
      case "mode": if (e.mode === "lazy") setItems((p) => [...p, { kind: "note", text: `${e.toolCount} tools available: using search-then-call mode to keep the model's context small.` }]); break;
      case "text":
        setItems((p) => {
          const last = p.at(-1);
          return last?.kind === "assistant" ? [...p.slice(0, -1), { kind: "assistant", text: last.text + e.delta }] : [...p, { kind: "assistant", text: e.delta }];
        });
        break;
      case "tool_call": setItems((p) => [...p, { kind: "tool", id: e.id, name: e.name, args: e.arguments }]); break;
      case "tool_result": setItems((p) => p.map((i) => (i.kind === "tool" && i.id === e.id ? { ...i, ok: e.ok, result: e.content, ms: e.durationMs, truncated: e.truncated } : i))); break;
      case "error": setError(e.message); break;
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <aside className="space-y-1 lg:sticky lg:top-20 lg:self-start">
        <Button className="mb-2 w-full" onClick={fresh}><MessageSquarePlus className="size-4" aria-hidden />New chat</Button>
        <div className="max-h-[60vh] space-y-0.5 overflow-y-auto">
          {convs.data?.conversations.map((c) => (
            <div key={c.id} className={cx("group flex items-center rounded-md", id === c.id ? "bg-accent-soft" : "hover:bg-raised")}>
              <button onClick={() => void open(c.id)} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm">{c.title}</button>
              <button aria-label={`Delete ${c.title}`} className="px-2 text-muted opacity-0 hover:text-bad focus:opacity-100 group-hover:opacity-100" onClick={async () => { await del(`/api/conversations/${c.id}`); if (id === c.id) fresh(); void qc.invalidateQueries({ queryKey: ["conversations"] }); }}><Trash2 className="size-4" /></button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-h-[70vh] flex-col">
        <div className="mb-4">
          <h1 className="text-3xl">Assistant</h1>
          <p className="mt-1 text-muted">Acts as you: it can only use the tools you can, and every call it makes is in the audit log under your name.</p>
        </div>
        {status.data && !status.data.configured && <div className="mb-3"><ErrorNote error={new Error("The assistant isn't configured yet. An admin needs to set LLM_API_KEY for the gateway.")} /></div>}

        <Panel className="flex flex-1 flex-col">
          <div className="flex-1 space-y-4 p-4" aria-live="polite">
            {items.length === 0 && !busy && (
              <div className="py-10">
                <p className="font-display text-xl">What do you want to do?</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {suggestions.map((s) => <button key={s} onClick={() => void send(s)} className="border border-line bg-raised px-3 py-1.5 text-left text-sm hover:border-accent">{s}</button>)}
                </div>
              </div>
            )}
            {items.map((it, n) => <Message key={n} item={it} />)}
            {busy && items.at(-1)?.kind !== "assistant" && <Spinner label="Working" />}
            {error && <ErrorNote error={new Error(error)} />}
            <div ref={endRef} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex items-end gap-2 border-t border-line p-3">
            <textarea
              rows={1} value={input} onChange={(e) => setInput(e.target.value)} aria-label="Message"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
              placeholder="Ask about orders, products, rates, cluster health…" maxLength={4000}
              className="max-h-40 min-h-10 flex-1 resize-y rounded-md border border-line bg-raised px-3 py-2 text-sm focus:border-accent"
            />
            <Button variant="primary" type="submit" disabled={!input.trim() || !status.data?.configured} busy={busy} aria-label="Send"><SendHorizontal className="size-4" /></Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

function Message({ item }: { item: Item }) {
  if (item.kind === "user") return <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-accent px-3 py-2 text-accent-ink">{item.text}</div>;
  if (item.kind === "note") return <p className="text-center text-xs text-muted">{item.text}</p>;
  if (item.kind === "assistant") return <div className="max-w-[85%] whitespace-pre-wrap leading-relaxed">{item.text}</div>;
  return <ToolStep item={item} />;
}

function ToolStep({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const pending = item.result === undefined;
  const meta = item.name.startsWith("gateway__") && typeof item.args === "object" && item.args && "name" in item.args ? String((item.args as { name: unknown }).name) : undefined;
  return (
    <details className="group rounded-md border border-line bg-raised text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <ChevronRight className="size-4 text-muted transition group-open:rotate-90" aria-hidden />
        <Wrench className="size-4 text-muted" aria-hidden />
        <ToolName name={meta ?? item.name} />
        {item.name.startsWith("gateway__") && <span className="text-xs text-muted">via {item.name.replace("gateway__", "")}</span>}
        <span className="ml-auto flex items-center gap-2">
          {item.ms != null && <span className="text-xs tabular-nums text-muted">{ms(item.ms)}</span>}
          {pending ? <Badge>Running</Badge> : <Badge tone={item.ok ? "ok" : "bad"}>{item.ok ? "Done" : "Failed"}</Badge>}
        </span>
      </summary>
      <div className="space-y-2 border-t border-line p-3">
        <div><p className="mb-1 text-xs text-muted">Arguments</p><pre className="overflow-x-auto rounded border border-line bg-surface p-2 font-mono text-xs">{typeof item.args === "string" ? item.args : JSON.stringify(item.args, null, 2)}</pre></div>
        {item.result !== undefined && <div><p className="mb-1 text-xs text-muted">Result{item.truncated ? " (shortened)" : ""}</p><pre className="max-h-64 overflow-auto rounded border border-line bg-surface p-2 font-mono text-xs">{pretty(item.result)}</pre></div>}
      </div>
    </details>
  );
}
const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };