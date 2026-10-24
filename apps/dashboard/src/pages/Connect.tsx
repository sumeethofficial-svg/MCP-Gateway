
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Copy, PlugZap, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { CopyButton, PageHeader, Panel, Spinner, ToolName } from "../components/ui";
import { get } from "../lib/api";
import type { GatewayInfo } from "../lib/types";

function Snippet({ title, note, code }: { title: string; note?: string; code: string }) {
  return (
    <Panel className="min-w-0 overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="hidden">
            <Terminal className="size-5" />
          </div>
          <div>
            <h3 className="font-semibold">{title}</h3>
            {note && <p className="mt-1 text-sm text-muted">{note}</p>}
          </div>
        </div>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-raised p-5 font-mono text-xs leading-relaxed sm:text-sm">{code}</pre>
    </Panel>
  );
}

export function Connect() {
  const info = useQuery({
    queryKey: ["gateway"],
    queryFn: () => get<GatewayInfo>("/api/gateway"),
  });

  if (info.isLoading || !info.data) return <Spinner />;

  const g = info.data;
  const KEY = "<your-api-key>";

  return (
    <div className="space-y-7">
      <PageHeader
        title="Connect a client"
        sub="Connect your preferred MCP client to the gateway and use your available tools."
      />

      <Panel className="overflow-hidden">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-4">
            <div className="hidden">
              <PlugZap className="size-6" />
            </div>
            <div>
              <h2 className="font-semibold">Your MCP endpoint</h2>
              <p className="mt-1 break-all font-mono text-sm text-muted">{g.mcpUrl}</p>
              <p className="mt-2 text-sm text-muted">{g.toolCount} tools available to your account</p>
            </div>
          </div>
          <Link to="/keys" className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90">
            Create API key <ArrowUpRight className="size-4" />
          </Link>
        </div>
      </Panel>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Client configuration</h2>
          <p className="mt-1 text-sm text-muted">Choose a client and copy the corresponding setup instructions.</p>
        </div>

        <Snippet
          title="Claude Code"
          note="Register the MCP endpoint from your terminal."
          code={`claude mcp add --transport http mcp-portal ${g.mcpUrl} \\\n  --header "Authorization: Bearer ${KEY}"`}
        />

        <Snippet
          title="Cursor and compatible clients"
          note="Add this configuration to your client's MCP server settings."
          code={JSON.stringify({
            mcpServers: {
              "mcp-portal": {
                url: g.mcpUrl,
                headers: { Authorization: `Bearer ${KEY}` },
              },
            },
          }, null, 2)}
        />

        <Snippet
          title="MCP Inspector"
          note="Inspect and interact with your MCP endpoint."
          code={`npx @modelcontextprotocol/inspector\n\nTransport: Streamable HTTP\nURL: ${g.mcpUrl}\nHeader: Authorization = Bearer ${KEY}`}
        />

        <Snippet
          title="Search-then-call endpoint"
          note={`Uses fewer tools in the initial context. The assistant switches to this mode automatically above ${g.lazyThreshold} tools.`}
          code={g.lazyMcpUrl}
        />
      </section>

      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Available tools</h2>
          <p className="mt-1 text-sm text-muted">Tools exposed by your connected servers and available under your permissions.</p>
        </div>

        <Panel>
          {g.tools.length === 0 ? (
            <div className="p-8 text-center">
              <PlugZap className="mx-auto size-8 text-muted" />
              <p className="mt-3 font-medium">No tools available</p>
              <p className="mt-1 text-sm text-muted">An administrator may need to connect a server or update your permissions.</p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {g.tools.map((tool) => (
                <li key={tool.name} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-start sm:gap-5">
                  <div className="sm:w-64 sm:shrink-0">
                    <ToolName name={tool.name} />
                  </div>
                  <p className="text-sm leading-relaxed text-muted">{tool.description}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {g.unreachable.length > 0 && (
          <p className="mt-4 rounded-lg border border-amber-300/50 bg-amber-50 p-4 text-sm text-amber-800">
            Currently unreachable: {g.unreachable.map((u) => u.server).join(", ")}. Their tools may be unavailable until the servers recover.
          </p>
        )}
      </section>
    </div>
  );
}
