
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlus, ShieldCheck, Users } from "lucide-react";
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
import { del, get, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, when } from "../lib/format";
import type { Invite, Role, TeamUser } from "../lib/types";

export function Team() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => get<{ users: TeamUser[] }>("/api/users"),
  });

  const invites = useQuery({
    queryKey: ["invites"],
    queryFn: () => get<{ invites: Invite[] }>("/api/invites"),
  });

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string>();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["users"] });
    void qc.invalidateQueries({ queryKey: ["invites"] });
  };

  const invite = useMutation({
    mutationFn: () => post<{ inviteUrl: string }>("/api/invites", { email, role }),
    onSuccess: (r) => {
      setLink(r.inviteUrl);
      refresh();
    },
    onError: (e) => toast(e.message, "bad"),
  });

  const update = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      role?: Role;
      disabled?: boolean;
    }) => patch(`/api/users/${id}`, body),
    onSuccess: () => {
      toast("Saved");
      refresh();
    },
    onError: (e) => toast(e.message, "bad"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => del(`/api/invites/${id}`),
    onSuccess: () => {
      toast("Invitation revoked");
      refresh();
    },
    onError: (e) => toast(e.message, "bad"),
  });

  const close = () => {
    setOpen(false);
    setLink(undefined);
    setEmail("");
    setRole("member");
    invite.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };

  const pending =
    invites.data?.invites.filter(
      (i) =>
        !i.acceptedAt &&
        !i.revokedAt &&
        new Date(i.expiresAt) > new Date(),
    ) ?? [];

  return (
    <>
      <PageHeader
        title="Team"
        sub="Manage workspace members, roles, account access, and pending invitations."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <MailPlus className="size-4" />
            Invite someone
          </Button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <Panel className="p-5">
          <div className="flex items-center gap-3">
            <div className="hidden">
              <Users className="size-5" />
            </div>
            <div>
              <p className="text-sm text-muted">Team members</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {users.isLoading ? "—" : users.data?.users.length ?? 0}
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
              <p className="text-sm text-muted">Pending invitations</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {invites.isLoading ? "—" : pending.length}
              </p>
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="mb-7 overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 className="font-semibold">Members</h2>
          <p className="mt-1 text-sm text-muted">
            Manage each person's role and access.
          </p>
        </div>

        {users.isLoading ? (
          <Spinner />
        ) : users.error ? (
          <div className="p-5 text-sm text-bad">
            Unable to load team members: {users.error.message}
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Active keys</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.data?.users.map((u) => {
                const self = u.id === me?.user.id;

                return (
                  <tr key={u.id}>
                    <Td>
                      <span className="block font-medium">
                        {u.name}
                        {self && (
                          <span className="ml-2 text-xs font-normal text-muted">
                            You
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted">{u.email}</span>
                    </Td>

                    <Td>
                      <Select
                        aria-label={`Role for ${u.name}`}
                        className="w-32"
                        value={u.role}
                        disabled={self}
                        onChange={(e) =>
                          update.mutate({
                            id: u.id,
                            role: e.target.value as Role,
                          })
                        }
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </Select>
                    </Td>

                    <Td className="tabular-nums">{u.activeKeys}</Td>

                    <Td>
                      {u.disabled ? (
                        <Badge tone="bad">Disabled</Badge>
                      ) : (
                        <Badge tone="ok">Active</Badge>
                      )}
                    </Td>

                    <Td className="text-right">
                      {!self && (
                        <Button
                          variant={u.disabled ? "secondary" : "danger"}
                          busy={
                            update.isPending &&
                            update.variables?.id === u.id
                          }
                          onClick={() =>
                            (u.disabled ||
                              confirm(
                                `Disable ${u.name}? Their sessions and API keys will stop working immediately.`,
                              )) &&
                            update.mutate({
                              id: u.id,
                              disabled: !u.disabled,
                            })
                          }
                        >
                          {u.disabled ? "Enable" : "Disable"}
                        </Button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 className="font-semibold">Pending invitations</h2>
          <p className="mt-1 text-sm text-muted">
            Invitations are single-use and expire automatically.
          </p>
        </div>

        {invites.isLoading ? (
          <Spinner />
        ) : pending.length === 0 ? (
          <Empty title="No pending invitations">
            Invite a teammate to give them access to this workspace.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Invited by</Th>
                <Th>Expires</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {pending.map((i) => (
                <tr key={i.id}>
                  <Td className="font-medium">{i.email}</Td>
                  <Td>
                    <Badge>{i.role}</Badge>
                  </Td>
                  <Td className="text-sm text-muted">
                    {i.invitedByEmail ?? "—"}
                  </Td>
                  <Td className="whitespace-nowrap text-sm text-muted">
                    {when(i.expiresAt)}
                    <span className="block text-xs">
                      {ago(i.expiresAt)}
                    </span>
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="danger"
                      busy={
                        revoke.isPending && revoke.variables === i.id
                      }
                      onClick={() =>
                        confirm(`Revoke the invitation for ${i.email}?`) &&
                        revoke.mutate(i.id)
                      }
                    >
                      Revoke
                    </Button>
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
        title={link ? "Invitation created" : "Invite a teammate"}
      >
        {link ? (
          <div className="space-y-5">
            <div className="rounded-xl border border-ok/30 bg-ok-soft p-4">
              <p className="font-semibold">Invitation link ready</p>
              <p className="mt-1 text-sm text-muted">
                Share this link with {email || "your teammate"}. It works once.
                The portal does not send email automatically.
              </p>
            </div>

            <code className="block break-all rounded-xl border border-line bg-raised p-4 font-mono text-sm">
              {link}
            </code>

            <div className="flex justify-end gap-2">
              <CopyButton text={link} label="Copy invitation link" />
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <Field label="Email address">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                placeholder="teammate@example.com"
              />
            </Field>

            <Field
              label="Role"
              hint="Members start with read-only access to trusted servers. Permissions can be adjusted later."
            >
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>

            {invite.error && <ErrorNote error={invite.error} />}

            <div className="flex justify-end gap-2">
              <Button type="button" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                busy={invite.isPending}
              >
                Create invitation
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
