
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Activity, ArrowUpRight, CheckCircle2, Clock3, Server as ServerIcon, Users } from "lucide-react";
import { Bars } from "../components/Bars";
import { Empty, Lamp, PageHeader, Panel, Spinner, ToolName, cx } from "../components/ui";
import { get, qs } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ms, num, pct } from "../lib/format";
import type { Server, Stats } from "../lib/types";
import { useState } from "react";

const windows = [
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
];

export function Overview() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === "admin";
  const [hours, setHours] = useState(24);

  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: () => get<{ servers: Server[] }>("/api/servers"),
    refetchInterval: 15_000,
  });

  const stats = useQuery({
    queryKey: ["stats", hours],
    queryFn: () => get<Stats>(`/api/stats${qs({ hours })}`),
    refetchInterval: 30_000,
  });

  const s = stats.data;
  const serverList = servers.data?.servers ?? [];
  const connected = serverList.filter((v) => v.status === "connected").length;

  return (
    <div className="space-y-7">
      <PageHeader
        title="Dashboard"
        sub={`Welcome back, ${me?.user.name.split(" ")[0] ?? "Administrator"}. Here's what's happening across your MCP Portal.`}
      />

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Connected servers</h2>
            <p className="mt-1 text-sm text-muted">Monitor the tools available to your team.</p>
          </div>
          <Link
            to="/servers"
            className="inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline"
          >
            Manage servers <ArrowUpRight className="size-4" />
          </Link>
        </div>

        {servers.isLoading ? (
          <Panel><Spinner /></Panel>
        ) : serverList.length === 0 ? (
          <Panel>
            <Empty
              title="No servers connected"
              action={isAdmin ? <Link to="/servers" className="font-medium text-accent underline">Connect your first server</Link> : undefined}
            >
              {isAdmin ? "Add an MCP server to make its tools available." : "Ask an administrator to connect an MCP server."}
            </Empty>
          </Panel>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {serverList.map((server) => (
              <article
                key={server.id}
                className="rounded-xl border border-line bg-surface p-5 transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="hidden">
                    <ServerIcon className="size-5" />
                  </div>
                  <Lamp status={server.status} />
                </div>

                <h3 className="mt-4 truncate text-base font-semibold">{server.name}</h3>
                <ToolName name={`${server.slug}__`} className="mt-1 text-xs" />

                <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
                  <span className="text-sm text-muted">Available tools</span>
                  <span className="text-lg font-semibold tabular-nums">{server.toolCount ?? 0}</span>
                </div>

                {server.status === "unreachable" && server.statusReason && (
                  <p className="mt-3 text-sm text-bad">{server.statusReason}</p>
                )}

                {!!server.quarantinedTools && (
                  <p className="mt-3 text-xs font-medium text-warn">
                    {server.quarantinedTools} tools awaiting review
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {isAdmin ? "Team activity" : "Your activity"}
            </h2>
            <p className="mt-1 text-sm text-muted">Usage and performance across your selected period.</p>
          </div>

          <div className="inline-flex rounded-lg border border-line bg-surface p-1" role="group" aria-label="Time window">
            {windows.map((w) => (
              <button
                key={w.hours}
                onClick={() => setHours(w.hours)}
                aria-pressed={hours === w.hours}
                className={cx(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  hours === w.hours
                    ? "bg-accent text-accent-ink"
                    : "text-muted hover:bg-raised hover:text-ink",
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {stats.isLoading || !s ? (
          <Panel><Spinner /></Panel>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[
                {
                  label: "Tool calls",
                  value: num(s.totals.calls),
                  icon: Activity,
                  description: "Total requests",
                },
                {
                  label: "Failure rate",
                  value: pct(s.totals.failures, s.totals.calls),
                  icon: CheckCircle2,
                  description: "Requests that failed",
                },
                {
                  label: "Median / p95 latency",
                  value: `${ms(s.totals.p50)} / ${ms(s.totals.p95)}`,
                  icon: Clock3,
                  description: "Response time",
                },
                {
                  label: isAdmin ? "Active people" : "Servers used",
                  value: num(isAdmin ? s.activeUsers : s.perServer.length),
                  icon: Users,
                  description: isAdmin ? "Team members active" : "Servers used in this period",
                },
              ].map((metric) => {
                const Icon = metric.icon;
                return (
                  <article key={metric.label} className="rounded-xl border border-line bg-surface p-5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-muted">{metric.label}</span>
                      <span className="hidden">
                        <Icon className="size-4" />
                      </span>
                    </div>
                    <p className="mt-4 break-words text-2xl font-semibold tracking-tight tabular-nums">
                      {metric.value}
                    </p>
                    <p className="mt-1 text-xs text-muted">{metric.description}</p>
                  </article>
                );
              })}
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[1.7fr_1fr]">
              <Panel className="min-w-0 p-5">
                <div className="mb-5">
                  <h3 className="font-semibold">Calls over time</h3>
                  <p className="mt-1 text-sm text-muted">Tool usage during the selected period.</p>
                </div>
                <Bars series={s.series} bucket={s.bucket} />
              </Panel>

              <Panel className="p-5">
                <h3 className="font-semibold">Most used tools</h3>
                <p className="mt-1 text-sm text-muted">Tools receiving the most requests.</p>

                {s.topTools.length === 0 ? (
                  <div className="grid min-h-48 place-items-center text-center">
                    <div>
                      <Activity className="mx-auto size-8 text-muted" />
                      <p className="mt-3 text-sm font-medium">No tool activity yet</p>
                      <p className="mt-1 text-sm text-muted">Send a message in Chat to get started.</p>
                      <Link to="/chat" className="mt-3 inline-block text-sm font-semibold text-accent hover:underline">
                        Open Chat
                      </Link>
                    </div>
                  </div>
                ) : (
                  <ol className="mt-4 space-y-4">
                    {s.topTools.map((tool, index) => {
                      const maxCalls = Math.max(...s.topTools.map((t) => t.calls), 1);
                      const width = `${(tool.calls / maxCalls) * 100}%`;

                      return (
                        <li key={tool.tool}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-raised text-xs font-semibold text-muted">
                                {index + 1}
                              </span>
                              <span className="min-w-0 truncate"><ToolName name={tool.tool} /></span>
                            </div>
                            <span className="text-sm font-semibold tabular-nums">{num(tool.calls)}</span>
                          </div>
                          <div className="ml-10 mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
                            <div className="h-full rounded-full bg-accent" style={{ width }} />
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Panel>
            </div>
          </>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/servers"
          className="flex items-center gap-4 rounded-xl border border-line bg-surface p-5 transition-shadow hover:shadow-md"
        >
          <span className="hidden">
            <ServerIcon className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">Manage servers</span>
            <span className="mt-1 block text-sm text-muted">{connected} of {serverList.length} connected</span>
          </span>
          <ArrowUpRight className="size-5 text-muted" />
        </Link>

        <Link
          to="/audit"
          className="flex items-center gap-4 rounded-xl border border-line bg-surface p-5 transition-shadow hover:shadow-md"
        >
          <span className="hidden">
            <Activity className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">View audit log</span>
            <span className="mt-1 block text-sm text-muted">Review tool calls and outcomes</span>
          </span>
          <ArrowUpRight className="size-5 text-muted" />
        </Link>
      </section>
    </div>
  );
}
