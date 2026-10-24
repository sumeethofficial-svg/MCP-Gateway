
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  CopyButton,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  useToast,
} from "../components/ui";
import { del, get, post } from "../lib/api";
import { ago, when } from "../lib/format";
import type { ApiKey } from "../lib/types";

function status(k: ApiKey) {
  if (k.revokedAt) {
    return <Badge tone="bad">Revoked</Badge>;
  }

  if (k.expiresAt && new Date(k.expiresAt) < new Date()) {
    return <Badge tone="warn">Expired</Badge>;
  }

  return <Badge tone="ok">Active</Badge>;
}

export function Keys() {
  const qc = useQueryClient();
  const toast = useToast();

  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: () => get<{ keys: ApiKey[] }>("/api/keys"),
  });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [secret, setSecret] = useState<string>();

  const create = useMutation({
    mutationFn: () =>
      post<{ plaintext: string }>("/api/keys", {
        name,
        expiresInDays: days === "never" ? undefined : Number(days),
      }),
    onSuccess: (r) => {
      setSecret(r.plaintext);
      setName("");
      void qc.invalidateQueries({ queryKey: ["keys"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => del(`/api/keys/${id}`),
    onSuccess: () => {
      toast("Key revoked. It stopped working immediately.");
      void qc.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (e) => toast(e.message, "bad"),
  });

  const close = () => {
    setOpen(false);
    setSecret(undefined);
    create.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  const activeCount =
    keys.data?.keys.filter(
      (k) =>
        !k.revokedAt &&
        !(k.expiresAt && new Date(k.expiresAt) < new Date()),
    ).length ?? 0;

  return (
    <>
      <PageHeader
        title="API keys"
        sub="Manage credentials for your MCP clients. Every call is permission-checked and recorded in the audit log."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            Create key
          </Button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <Panel className="p-5">
          <div className="flex items-center gap-3">
            <div className="hidden">
              <KeyRound className="size-5" />
            </div>
            <div>
              <p className="text-sm text-muted">Total keys</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {keys.isLoading ? "—" : keys.data?.keys.length ?? 0}
              </p>
            </div>
          </div>
        </Panel>

        <Panel className="p-5">
          <div className="flex items-center gap-3">
            <div className="hidden">
              <ShieldCheck className="size-5" />
            </div>
            <div>
              <p className="text-sm text-muted">Usable keys</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {keys.isLoading ? "—" : activeCount}
              </p>
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="overflow-hidden">
        {keys.isLoading ? (
          <Spinner />
        ) : !keys.data?.keys.length ? (
          <Empty
            title="No API keys yet"
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                <Plus className="size-4" />
                Create your first key
              </Button>
            }
          >
            Create a key, then add it to your MCP client's configuration.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Key prefix</Th>
                <Th>Status</Th>
                <Th>Last used</Th>
                <Th>Expires</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {keys.data.keys.map((k) => (
                <tr key={k.id}>
                  <Td>
                    <span className="font-medium">{k.name}</span>
                  </Td>
                  <Td>
                    <code className="rounded-md border border-line bg-raised px-2 py-1 font-mono text-xs text-muted">
                      {k.prefix}…
                    </code>
                  </Td>
                  <Td>{status(k)}</Td>
                  <Td className="whitespace-nowrap text-sm text-muted">
                    {ago(k.lastUsedAt)}
                  </Td>
                  <Td className="whitespace-nowrap text-sm text-muted">
                    {k.expiresAt ? when(k.expiresAt) : "Never"}
                  </Td>
                  <Td className="text-right">
                    {!k.revokedAt && (
                      <Button
                        variant="danger"
                        busy={revoke.isPending && revoke.variables === k.id}
                        onClick={() =>
                          confirm(
                            `Revoke "${k.name}"? Clients using it will stop working immediately.`,
                          ) && revoke.mutate(k.id)
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Dialog
        open={open}
        onClose={close}
        title={secret ? "Copy your key now" : "Create API key"}
      >
        {secret ? (
          <div className="space-y-5">
            <div className="rounded-xl border border-warn/40 bg-warn-soft p-4">
              <p className="text-sm font-semibold">Save this key securely</p>
              <p className="mt-1 text-sm text-muted">
                The full key is only shown once. If you lose it, create a
                replacement.
              </p>
            </div>

            <code className="block break-all rounded-xl border border-line bg-raised p-4 font-mono text-sm">
              {secret}
            </code>

            <div className="flex justify-end gap-2">
              <CopyButton text={secret} label="Copy key" />
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <Field
              label="Key name"
              hint="Choose a name that identifies where this key will be used."
            >
              <Input
                required
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder="e.g. Cursor on laptop"
              />
            </Field>

            <Field label="Expiration">
              <Select
                value={days}
                onChange={(e) => setDays(e.target.value)}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="never">Never expires</option>
              </Select>
            </Field>

            {create.error && <ErrorNote error={create.error} />}

            <div className="flex justify-end gap-2">
              <Button type="button" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                busy={create.isPending}
              >
                Create key
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
