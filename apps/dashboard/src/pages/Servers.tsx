import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, Input, Lamp, PageHeader, Panel, Select, Spinner, Table, Td, Th, ToolName, useToast } from "../components/ui";
import { del, get, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, ms } from "../lib/format";
import type { Rule, Server, ServerTool, ServerTools, TeamUser } from "../lib/types";

interface TestResult { ok: boolean; latencyMs?: number; error?: string; tools?: { name: string; description: string; flagged: boolean; findings: string }[] }
type Form = { slug: string; name: string; url: string; authType: "none" | "bearer" | "header"; authHeaderName: string; credential: string; trustAnnotations: boolean };
const blank: Form = { slug: "", name: "", url: "", authType: "bearer", authHeaderName: "", credential: "", trustAnnotations: false };

export function Servers() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === "admin";
  const qc = useQueryClient();
  const toast = useToast();
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => get<{ servers: Server[] }>("/api/servers"), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<Server | "new">();
  const [toolsFor, setToolsFor] = useState<Server>();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["servers"] }); void qc.invalidateQueries({ queryKey: ["gateway"] }); };

  const check = useMutation({ mutationFn: (id: string) => post(`/api/servers/${id}/check`), onSuccess: () => { refresh(); toast("Checked"); }, onError: (e) => toast(e.message, "bad") });
  const toggle = useMutation({ mutationFn: (s: Server) => patch(`/api/servers/${s.id}`, { enabled: !s.enabled }), onSuccess: refresh, onError: (e) => toast(e.message, "bad") });
  const remove = useMutation({ mutationFn: (id: string) => del(`/api/servers/${id}`), onSuccess: () => { refresh(); toast("Server removed"); }, onError: (e) => toast(e.message, "bad") });

  return (
    <>
      <PageHeader
        title="Servers"
        sub={isAdmin ? "MCP servers behind the gateway. Their credentials stay on the server side and are never sent to anyone's browser or client." : "The MCP servers your tools come from, and whether they're up."}
        actions={isAdmin && <Button variant="primary" onClick={() => setEditing("new")}>Add server</Button>}
      />
      <Panel>
        {servers.isLoading ? <Spinner /> : !servers.data?.servers.length ? (
          <Empty title="No servers yet" action={isAdmin ? <Button variant="primary" onClick={() => setEditing("new")}>Add a server</Button> : undefined}>Servers you add appear here with live status.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {servers.data.servers.map((s) => (
              <li key={s.id} className="space-y-2 px-4 py-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {s.name}
                      {s.managedBy === "helm" && <Badge tone="accent">Managed by Helm</Badge>}
                      {s.managedBy === "provisioner" && <Badge tone="accent">Store</Badge>}
                      {s.trustAnnotations === false && isAdmin && <Badge>Annotations untrusted</Badge>}
                      {!!s.quarantinedTools && <Badge tone="warn"><ShieldAlert className="size-3" aria-hidden />{s.quarantinedTools} awaiting review</Badge>}
                    </p>
                    {s.url && <p className="truncate font-mono text-xs text-muted">{s.url}</p>}
                  </div>
                  <Lamp status={s.status} />
                  <span className="w-20 text-sm text-muted">{s.toolCount ?? 0} tools</span>
                  {isAdmin && <span className="w-20 text-sm tabular-nums text-muted">{s.latencyMs != null ? ms(s.latencyMs) : ""}</span>}
                </div>
                {s.status === "unreachable" && s.statusReason && <p className="text-sm text-bad">{s.statusReason}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => setToolsFor(s)} disabled={!s.enabled}>Tools</Button>
                  {isAdmin && (
                    <>
                      <Button variant="ghost" onClick={() => check.mutate(s.id)} busy={check.isPending && check.variables === s.id} disabled={!s.enabled}><RefreshCw className="size-4" aria-hidden />Check now</Button>
                      {s.managedBy !== "provisioner" && <Button variant="ghost" onClick={() => setEditing(s)}>Edit</Button>}
                      <Button variant="ghost" onClick={() => toggle.mutate(s)}>{s.enabled ? "Disable" : "Enable"}</Button>
                      {s.managedBy !== "provisioner" && <Button variant="ghost" className="text-bad" onClick={() => confirm(`Remove ${s.name}? Its tools disappear for everyone. Audit history is kept.`) && remove.mutate(s.id)}>Remove</Button>}
                      <span className="ml-auto text-xs text-muted">Checked {ago(s.lastCheckedAt)}</span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {isAdmin && <Permissions servers={servers.data?.servers ?? []} />}
      {editing && <ServerForm key={editing === "new" ? "new" : editing.id} server={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={refresh} />}
      {toolsFor && <ToolsDialog server={toolsFor} isAdmin={!!isAdmin} onClose={() => setToolsFor(undefined)} onChanged={refresh} />}
    </>
  );
}

// ---- add / edit ---------------------------------------------------------------
function ServerForm({ server, onClose, onSaved }: { server?: Server; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<Form>(server ? { slug: server.slug, name: server.name, url: server.url ?? "", authType: server.authType ?? "none", authHeaderName: server.authHeaderName ?? "", credential: "", trustAnnotations: !!server.trustAnnotations } : blank);
  const [test, setTest] = useState<TestResult>();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const body = { name: f.name, url: f.url, authType: f.authType, authHeaderName: f.authType === "header" ? f.authHeaderName : null, trustAnnotations: f.trustAnnotations, ...(f.credential ? { credential: f.credential } : {}) };

  const runTest = useMutation({
    mutationFn: () => post<TestResult>("/api/servers/test", { url: f.url, authType: f.authType, authHeaderName: f.authType === "header" ? f.authHeaderName : null, credential: f.credential || null }),
    onSuccess: setTest,
  });
  const save = useMutation({
    mutationFn: () => (server ? patch(`/api/servers/${server.id}`, body) : post("/api/servers", { slug: f.slug, ...body })),
    onSuccess: () => { toast(server ? "Server updated" : "Server added"); onSaved(); onClose(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  return (
    <Dialog open onClose={onClose} title={server ? `Edit ${server.name}` : "Add server"}>
      <form onSubmit={submit} className="space-y-4">
        {!server && <Field label="Short name" hint="Becomes the prefix of its tools, like “shop” in shop/list_orders. Lowercase letters, digits and dashes. Can't be changed later."><Input required maxLength={24} pattern="[a-z0-9][a-z0-9-]*" value={f.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} autoFocus /></Field>}
        <Field label="Display name"><Input required value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="MCP endpoint URL" hint="The Streamable HTTP URL, for example http://woo-mcp.store.svc:3000/mcp"><Input required type="url" value={f.url} onChange={(e) => set("url", e.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Authentication"><Select value={f.authType} onChange={(e) => set("authType", e.target.value as Form["authType"])}><option value="bearer">Bearer token</option><option value="header">Custom header</option><option value="none">None</option></Select></Field>
          {f.authType === "header" && <Field label="Header name"><Input required value={f.authHeaderName} onChange={(e) => set("authHeaderName", e.target.value)} placeholder="X-Api-Key" /></Field>}
        </div>
        {f.authType !== "none" && <Field label="Credential" hint={server?.hasCredential ? "Stored encrypted. Leave blank to keep the current one." : "Stored encrypted. It's never shown again."}><Input type="password" autoComplete="off" value={f.credential} onChange={(e) => set("credential", e.target.value)} /></Field>}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={f.trustAnnotations} onChange={(e) => set("trustAnnotations", e.target.checked)} />
          <span><span className="font-medium">Trust this server's read-only labels</span><span className="block text-muted">When on, tools it marks read-only are available to members by default. Leave off for servers you don't run yourself.</span></span>
        </label>

        {test && (
          <div className={`rounded-md border p-3 text-sm ${test.ok ? "border-ok/40 bg-ok-soft" : "border-bad/40 bg-bad-soft text-bad"}`}>
            {test.ok ? (
              <>
                <p className="font-medium text-ok">Connected in {ms(test.latencyMs ?? 0)}. Found {test.tools?.length ?? 0} tools.</p>
                <ul className="mt-1 space-y-0.5">{test.tools?.map((t) => <li key={t.name} className="text-ink">{t.flagged ? "⚠ " : ""}<code className="font-mono text-xs">{t.name}</code>{t.flagged && <span className="text-warn"> flagged: {t.findings}</span>}</li>)}</ul>
              </>
            ) : test.error}
          </div>
        )}
        {(runTest.error || save.error) && <ErrorNote error={runTest.error ?? save.error} />}
        <div className="flex flex-wrap justify-between gap-2">
          <Button type="button" onClick={() => runTest.mutate()} busy={runTest.isPending} disabled={!f.url}>Test connection</Button>
          <div className="flex gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" busy={save.isPending}>{server ? "Save changes" : "Add server"}</Button></div>
        </div>
      </form>
    </Dialog>
  );
}

// ---- tools (+ quarantine review) -----------------------------------------------
function ToolsDialog({ server, isAdmin, onClose, onChanged }: { server: Server; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["server-tools", server.id], queryFn: () => get<ServerTools>(`/api/servers/${server.id}/tools`) });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => get<{ rules: Rule[] }>("/api/policies"), enabled: isAdmin });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["server-tools", server.id] }); void qc.invalidateQueries({ queryKey: ["rules"] }); onChanged(); };
  const review = useMutation({
    mutationFn: ({ tool, decision, defHash }: { tool: ServerTool; decision: "approved" | "rejected"; defHash: string }) => post(`/api/servers/${server.id}/tools/${encodeURIComponent(tool.name)}/review`, { decision, defHash }),
    onSuccess: (_d, v) => { toast(v.decision === "approved" ? "Approved. The tool is live." : "Rejected. It stays hidden."); refresh(); },
    onError: (e) => toast(e.message, "bad"),
  });
  const setMember = useMutation({
    mutationFn: async ({ tool, effect }: { tool: ServerTool; effect: "allow" | "deny" | "default" }) => {
      const existing = rules.data?.rules.filter((r) => r.subjectType === "role" && r.subject === "member" && r.serverSlug === server.slug && r.toolName === tool.name) ?? [];
      await Promise.all(existing.map((r) => del(`/api/policies/${r.id}`)));
      if (effect !== "default") await post("/api/policies", { subjectType: "role", subject: "member", serverSlug: server.slug, toolName: tool.name, effect });
    },
    onSuccess: refresh,
    onError: (e) => toast(e.message, "bad"),
  });
  const data = q.data;
  const memberValue = (t: ServerTool) => rules.data?.rules.find((r) => r.subjectType === "role" && r.subject === "member" && r.serverSlug === server.slug && r.toolName === t.name)?.effect ?? "default";

  return (
    <Dialog open onClose={onClose} title={`${server.name} tools`} wide>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : data && (
        <div className="space-y-3">
          {!data.reachable && <p className="rounded-md border border-warn/40 bg-warn-soft p-2 text-sm text-warn">Server is unreachable{data.error ? `: ${data.error}` : ""}. {data.tools.length ? "Showing the last known tools." : ""}</p>}
          {data.tools.length === 0 && <Empty title="No tools to show">{isAdmin ? "This server hasn't reported any tools, or all are hidden." : "No tools on this server are available to you."}</Empty>}
          {data.tools.map((t) => (
            <article key={t.name} className="rounded-md border border-line bg-raised p-3">
              <div className="flex flex-wrap items-center gap-2">
                <ToolName name={t.exposedName} />
                {t.annotations?.readOnlyHint && <Badge tone="ok">Read-only</Badge>}
                {t.annotations?.destructiveHint && <Badge tone="bad">Destructive</Badge>}
                {t.pin.status === "quarantined" && <Badge tone="warn">Needs review</Badge>}
                {t.pin.status === "rejected" && <Badge tone="bad">Rejected</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted">{t.description}</p>

              {isAdmin && t.pin.status !== "approved" && (
                <div className="mt-3 space-y-2 rounded border border-warn/40 bg-warn-soft p-3 text-sm">
                  <p className="font-medium text-warn">{(t.pin.reason ?? "This tool was held back").replace(/\.?$/, ".")} Nobody can call it until you decide.</p>
                  {t.pin.previousDescription && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div><p className="text-xs text-muted">Approved before</p><p className="rounded border border-line bg-surface p-2 text-xs">{t.pin.previousDescription}</p></div>
                      <div><p className="text-xs text-muted">Now</p><p className="rounded border border-line bg-surface p-2 text-xs">{t.description}</p></div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => review.mutate({ tool: t, decision: "approved", defHash: t.pin.defHash! })}>Approve this version</Button>
                    <Button variant="danger" onClick={() => review.mutate({ tool: t, decision: "rejected", defHash: t.pin.defHash! })}>Keep hidden</Button>
                  </div>
                </div>
              )}

              {isAdmin && t.access && t.pin.status === "approved" && (
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <span className="text-muted">Members</span>
                    <Select className="w-44 py-1" value={memberValue(t)} onChange={(e) => setMember.mutate({ tool: t, effect: e.target.value as "allow" | "deny" | "default" })}>
                      <option value="default">Default</option><option value="allow">Always allow</option><option value="deny">Always deny</option>
                    </Select>
                  </label>
                  <span className={t.access.member.allowed ? "text-ok" : "text-muted"}>{t.access.member.allowed ? "Allowed" : "Blocked"}: {t.access.member.reason}</span>
                </div>
              )}
              <details className="mt-2 text-sm"><summary className="cursor-pointer text-muted">Input schema</summary><pre className="mt-1 overflow-x-auto rounded border border-line bg-surface p-2 font-mono text-xs">{JSON.stringify(t.inputSchema, null, 2)}</pre></details>
            </article>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ---- permission rules ---------------------------------------------------------
function Permissions({ servers }: { servers: Server[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => get<{ rules: Rule[] }>("/api/policies") });
  const users = useQuery({ queryKey: ["users"], queryFn: () => get<{ users: TeamUser[] }>("/api/users") });
  const [r, setR] = useState({ subjectType: "role", subject: "member", serverSlug: "*", toolName: "*", effect: "allow" });
  const done = () => void qc.invalidateQueries({ queryKey: ["rules"] });
  const add = useMutation({ mutationFn: () => post("/api/policies", r), onSuccess: () => { toast("Rule added"); done(); }, onError: (e) => toast(e.message, "bad") });
  const remove = useMutation({ mutationFn: (id: string) => del(`/api/policies/${id}`), onSuccess: done, onError: (e) => toast(e.message, "bad") });
  const serverName = r.serverSlug === "*" ? "every server" : (servers.find((s) => s.slug === r.serverSlug)?.name ?? r.serverSlug);
  const subjectName = r.subjectType === "role" ? (r.subject === "admin" ? "Admins" : "Members") : (users.data?.users.find((u) => u.id === r.subject)?.name ?? "This person");
  const toolText = r.toolName === "*" ? `every tool on ${serverName}` : `the tool "${r.toolName}" on ${serverName}`;
  const preview = `${subjectName} will ${r.effect === "allow" ? "be allowed to call" : "be blocked from calling"} ${toolText}.`;
  const broadAllow = r.effect === "allow" && r.toolName === "*" && r.subject !== "admin";
  const who = (x: Rule) => (x.subjectType === "role" ? `All ${x.subject}s` : (users.data?.users.find((u) => u.id === x.subject)?.email ?? x.subject));

  return (
    <>
      <h2 className="mb-1 mt-10 text-xl">Permissions</h2>
      <p className="mb-3 max-w-prose text-muted">By default members can use read-only tools from servers you trust, and admins can use everything. Rules override that. The most specific rule wins, and deny beats allow at equal specificity.</p>
      <Panel>
        <form onSubmit={(e) => { e.preventDefault(); if (broadAllow && !window.confirm(`${preview}\n\nThis includes tools that change data. Continue?`)) return; add.mutate(); }} className="grid gap-2 border-b border-line p-4 md:grid-cols-6">
          <Select aria-label="Applies to" value={r.subjectType} onChange={(e) => setR({ ...r, subjectType: e.target.value, subject: e.target.value === "role" ? "member" : (users.data?.users[0]?.id ?? "") })}><option value="role">A role</option><option value="user">One person</option></Select>
          {r.subjectType === "role"
            ? <Select aria-label="Role" value={r.subject} onChange={(e) => setR({ ...r, subject: e.target.value })}><option value="member">Members</option><option value="admin">Admins</option></Select>
            : <Select aria-label="Person" value={r.subject} onChange={(e) => setR({ ...r, subject: e.target.value })}>{users.data?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}
          <Select aria-label="Server" value={r.serverSlug} onChange={(e) => setR({ ...r, serverSlug: e.target.value })}><option value="*">Any server</option>{servers.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}</Select>
          <Input aria-label="Tool" value={r.toolName === "*" ? "" : r.toolName} onChange={(e) => setR({ ...r, toolName: e.target.value.trim() || "*" })} placeholder="Any tool (or type a name)" />
          <Select aria-label="Effect" value={r.effect} onChange={(e) => setR({ ...r, effect: e.target.value })}><option value="allow">Allow</option><option value="deny">Deny</option></Select>
          <Button variant="primary" type="submit" busy={add.isPending}>Add rule</Button>
        </form>
        <p className={`border-b border-line px-4 py-2 text-sm ${broadAllow ? "text-warn" : "text-muted"}`} aria-live="polite">{preview}{broadAllow ? " That includes tools that change data." : ""}</p>
        {!rules.data?.rules.length ? <Empty title="No custom rules">Defaults apply.</Empty> : (
          <Table>
            <thead><tr><Th>Applies to</Th><Th>Server</Th><Th>Tool</Th><Th>Effect</Th><Th /></tr></thead>
            <tbody>
              {rules.data.rules.map((x) => (
                <tr key={x.id}><Td>{who(x)}</Td><Td>{x.serverSlug === "*" ? "Any" : x.serverSlug}</Td><Td>{x.toolName === "*" ? "Any" : <code className="font-mono text-[13px]">{x.toolName}</code>}</Td>
                  <Td><Badge tone={x.effect === "allow" ? "ok" : "bad"}>{x.effect === "allow" ? "Allow" : "Deny"}</Badge></Td>
                  <Td className="text-right"><Button variant="ghost" onClick={() => remove.mutate(x.id)}>Remove</Button></Td></tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
