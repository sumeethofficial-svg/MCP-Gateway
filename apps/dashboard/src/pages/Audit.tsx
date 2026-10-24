
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity, ChevronDown, Filter } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  Empty,
  Input,
  PageHeader,
  Panel,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  ToolName,
} from "../components/ui";
import { get, qs } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ms, when } from "../lib/format";
import type { AuditRow, Server, TeamUser } from "../lib/types";

const outcomeTone = (o: string) =>
  o === "ok"
    ? "ok"
    : ["denied", "quarantined", "rate_limited"].includes(o)
      ? "warn"
      : "bad";

const outcomes = [
  "ok",
  "tool_error",
  "error",
  "timeout",
  "unavailable",
  "denied",
  "quarantined",
  "rate_limited",
  "not_found",
];

function prettyArgs(preview: string | null): string {
  if (!preview) return "(no arguments)";

  try {
    return JSON.stringify(JSON.parse(preview), null, 2);
  } catch {
    return preview;
  }
}

export function Audit() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === "admin";

  const [f, setF] = useState({
    userId: "",
    server: "",
    outcome: "",
    tool: "",
  });

  const [open, setOpen] = useState<number>();

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => get<{ users: TeamUser[] }>("/api/users"),
    enabled: isAdmin,
  });

  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: () => get<{ servers: Server[] }>("/api/servers"),
  });

  const log = useInfiniteQuery({
    queryKey: ["audit", f],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<{ rows: AuditRow[]; nextCursor: number | null }>(
        `/api/audit${qs({ ...f, before: pageParam, limit: 50 })}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 20_000,
  });

  const rows = log.data?.pages.flatMap((p) => p.rows) ?? [];

  const set = (k: keyof typeof f) =>
    (e: { target: { value: string } }) =>
      setF((previous) => ({ ...previous, [k]: e.target.value }));

  return (
    <>
      <PageHeader
        title="Audit log"
        sub={
          isAdmin
            ? "Review tool calls across your team, including their source, outcome, and response time."
            : "Review your tool calls, outcomes, and response times."
        }
      />

      <Panel className="mb-5 p-4">
        <div className="mb-4 flex items-center gap-2">
          <Filter className="size-4 text-muted" />
          <h2 className="text-sm font-semibold">Filter activity</h2>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {isAdmin && (
            <Select
              aria-label="Person"
              value={f.userId}
              onChange={set("userId")}
            >
              <option value="">Everyone</option>
              {users.data?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          )}

          <Select
            aria-label="Server"
            value={f.server}
            onChange={set("server")}
          >
            <option value="">All servers</option>
            {servers.data?.servers.map((s) => (
              <option key={s.id} value={s.slug}>
                {s.name}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Outcome"
            value={f.outcome}
            onChange={set("outcome")}
          >
            <option value="">Any outcome</option>
            <option value="failed">Any failure</option>
            {outcomes.map((o) => (
              <option key={o} value={o}>
                {o.replace(/_/g, " ")}
              </option>
            ))}
          </Select>

          <Input
            aria-label="Tool name"
            placeholder="Search tool names…"
            value={f.tool}
            onChange={set("tool")}
          />
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-accent" />
            <h2 className="font-semibold">Recent activity</h2>
          </div>
          <span className="text-xs text-muted">
            Refreshes every 20 seconds
          </span>
        </div>

        {log.isLoading ? (
          <Spinner />
        ) : log.error ? (
          <div className="p-5 text-sm text-bad">
            Unable to load audit events: {log.error.message}
          </div>
        ) : rows.length === 0 ? (
          <Empty title="No activity found">
            Tool calls will appear here when someone uses a tool.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                {isAdmin && <Th>Person</Th>}
                <Th>Tool</Th>
                <Th>Source</Th>
                <Th>Outcome</Th>
                <Th>Duration</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <>
                  <tr
                    key={r.id}
                    className="cursor-pointer transition-colors hover:bg-raised/60"
                    onClick={() =>
                      setOpen((previous) =>
                        previous === r.id ? undefined : r.id,
                      )
                    }
                  >
                    <Td className="whitespace-nowrap text-sm text-muted">
                      {when(r.ts)}
                    </Td>

                    {isAdmin && (
                      <Td className="text-sm">
                        {r.userEmail ?? "—"}
                      </Td>
                    )}

                    <Td>
                      {r.exposedName ? (
                        <ToolName name={r.exposedName} />
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>

                    <Td className="text-sm text-muted">
                      {r.via === "chat"
                        ? "Chat"
                        : (r.clientName?.split("/")[0] ?? "API key")}
                      {r.keyPrefix && r.via !== "chat"
                        ? ` · ${r.keyPrefix}…`
                        : ""}
                    </Td>

                    <Td>
                      <Badge tone={outcomeTone(r.outcome)}>
                        {r.outcome.replace(/_/g, " ")}
                      </Badge>
                    </Td>

                    <Td className="whitespace-nowrap text-sm tabular-nums text-muted">
                      {ms(r.durationMs)}
                    </Td>

                    <Td>
                      <ChevronDown
                        className={`size-4 text-muted transition-transform ${
                          open === r.id ? "rotate-180" : ""
                        }`}
                      />
                    </Td>
                  </tr>

                  {open === r.id && (
                    <tr key={`${r.id}-details`}>
                      <td
                        colSpan={isAdmin ? 7 : 6}
                        className="border-b border-line bg-raised/50 px-4 py-4"
                      >
                        {r.errorMessage && (
                          <div className="mb-3 rounded-lg border border-bad/30 bg-bad-soft p-3 text-sm text-bad">
                            {r.errorMessage}
                          </div>
                        )}

                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
                          Arguments
                        </p>
                        <pre className="max-h-72 overflow-auto rounded-xl border border-line bg-surface p-4 font-mono text-xs leading-relaxed">
                          {prettyArgs(r.argsPreview)}
                        </pre>

                        <p className="mt-2 text-xs text-muted">
                          Secrets are redacted before arguments are stored.
                        </p>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </Table>
        )}

        {log.hasNextPage && (
          <div className="border-t border-line p-4 text-center">
            <Button
              busy={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              Load older activity
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}
