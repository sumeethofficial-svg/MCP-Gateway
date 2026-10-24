import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, Input, PageHeader, Panel, Spinner, Table, Td, Th, useToast } from "../components/ui";
import { del, get, post } from "../lib/api";
import { ago } from "../lib/format";
import { useAuth } from "../lib/auth";
import type { StorePhase, StoreRow } from "../lib/types";

const PHASE: Record<StorePhase, { tone: "ok" | "warn" | "bad" | "neutral"; label: string }> = {
  Provisioning: { tone: "warn", label: "Provisioning" },
  Ready: { tone: "ok", label: "Ready" },
  Failed: { tone: "bad", label: "Failed" },
  Deleting: { tone: "neutral", label: "Deleting" },
};

/** "2m 10s" since a store was requested. Re-rendered by the polling below, so it advances while the page is open. */
function elapsed(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 11)
    .replace(/-+$/g, "") || "store";

/** The id doubles as an idempotency key: the same id sent again is the same store, never a second one. */
const makeId = (name: string) => `${slug(name)}-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

function PhaseBadge({ s }: { s: StoreRow }) {
  const p = PHASE[s.phase];
  const busy = s.phase === "Provisioning" || s.phase === "Deleting";
  return (
    <Badge tone={p.tone}>
      {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {p.label}
      {s.phase === "Provisioning" && <span className="font-normal opacity-80"> · {elapsed(s.createdAt)}</span>}
    </Badge>
  );
}

export function Stores() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === "admin";
  const qc = useQueryClient();
  const toast = useToast();

  const stores = useQuery({
    queryKey: ["stores"],
    queryFn: () => get<{ enabled: boolean; stores: StoreRow[] }>("/api/stores"),
    // Poll quickly while anything is changing, slowly otherwise.
    refetchInterval: (q) => (q.state.data?.stores.some((s) => s.phase === "Provisioning" || s.phase === "Deleting") ? 3000 : 15000),
  });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const idRef = useRef<string>();

  const create = useMutation({
    mutationFn: () => {
      idRef.current ??= makeId(name);
      return post<{ store: StoreRow; created: boolean }>("/api/stores", { name: name.trim(), id: idRef.current });
    },
    onSuccess: (r) => {
      toast(r.created ? `Creating "${r.store.name}". This takes a few minutes.` : `"${r.store.name}" already exists.`);
      close();
      void qc.invalidateQueries({ queryKey: ["stores"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/stores/${id}`),
    onSuccess: () => {
      toast("Deleting the store and everything in it.");
      void qc.invalidateQueries({ queryKey: ["stores"] });
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (e) => toast(e.message, "bad"),
  });

  function close() {
    setOpen(false);
    setName("");
    idRef.current = undefined;
    create.reset();
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  const enabled = stores.data?.enabled !== false;
  const list = stores.data?.stores ?? [];

  return (
    <>
      <PageHeader
        title="Stores"
        sub={isAdmin ? "Every store on this platform. Each one runs in its own namespace with its own database, credentials and volumes." : "Your WooCommerce stores. Each one runs in its own namespace, isolated from everyone else's."}
        actions={
          enabled && (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Create store
            </Button>
          )
        }
      />

      <Panel className="overflow-hidden">
        {stores.isLoading ? (
          <Spinner />
        ) : stores.isError ? (
          <div className="p-4">
            <ErrorNote error={stores.error} />
          </div>
        ) : !enabled ? (
          <Empty title="Multi-store provisioning is not enabled">An operator can turn it on with platform.stores.enabled in the Helm values.</Empty>
        ) : list.length === 0 ? (
          <Empty
            title="No stores yet"
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                <Plus className="size-4" aria-hidden />
                Create your first store
              </Button>
            }
          >
            Creating a store sets up WordPress, WooCommerce and a database in a private namespace, then connects it to the chat assistant. It takes a few minutes.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Store</Th>
                <Th>Status</Th>
                <Th>URL</Th>
                {isAdmin && <Th>Owner</Th>}
                <Th>Tools</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <Td className="whitespace-nowrap">
                    <p className="font-medium">{s.name}</p>
                    <p className="font-mono text-xs text-muted">{s.id}</p>
                  </Td>
                  <Td>
                    <span className="whitespace-nowrap"><PhaseBadge s={s} /></span>
                    {s.phase === "Failed" && s.reason && <p className="mt-1 max-w-xs text-xs text-bad">{s.reason}</p>}
                  </Td>
                  <Td className="max-w-[14rem] break-all">
                    {s.phase === "Ready" ? (
                      <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                        {s.url.replace(/^https?:\/\//, "")}
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : (
                      <span className="text-muted">{s.url.replace(/^https?:\/\//, "")}</span>
                    )}
                  </Td>
                  {isAdmin && <Td className="max-w-[10rem] break-all text-sm text-muted">{s.ownerEmail ?? (s.owned ? "you" : "—")}</Td>}
                  <Td className="max-w-[10rem] break-all">
                    {s.toolPrefix ? (
                      <code className="font-mono text-xs">
                        {s.toolPrefix}
                        <span className="text-muted">*</span>
                      </code>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-sm text-muted">{ago(s.createdAt)}</Td>
                  <Td className="text-right">
                    {s.phase !== "Deleting" && (
                      <Button
                        variant="danger"
                        busy={remove.isPending && remove.variables === s.id}
                        onClick={() => confirm(`Delete "${s.name}"? Its database, products, orders and credentials are removed permanently.`) && remove.mutate(s.id)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                        Delete
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Dialog open={open} onClose={close} title="Create a store">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Store name" hint="Shown here and in the chat. The store's address and tool names are derived from it.">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                idRef.current = undefined; // a different name is a different request
              }}
              placeholder="Berlin Books"
              maxLength={60}
              required
              autoFocus
            />
          </Field>
          {create.isError && <ErrorNote error={create.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={create.isPending} disabled={!name.trim()}>
              Create store
            </Button>
          </div>
          <p className="text-xs text-muted">If something goes wrong you can press Create again: the same request never creates a second store.</p>
        </form>
      </Dialog>
    </>
  );
}
