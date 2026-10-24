
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ArrowRight, UserRoundPlus } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { get, post, qs } from "../lib/api";
import { Button, ErrorNote, Field, Input, Spinner } from "../components/ui";
import { AuthShell } from "./Login";

export function AcceptInvite() {
  const token = useSearchParams()[0].get("token") ?? "";
  const nav = useNavigate();
  const qc = useQueryClient();

  const preview = useQuery({
    queryKey: ["invite", token],
    queryFn: () =>
      get<{ email: string; role: string }>(
        `/api/invites/preview${qs({ token })}`,
      ),
    retry: false,
    enabled: !!token,
  });

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      await post("/api/invites/accept", { token, name, password });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell
        title="Invite link incomplete"
        sub="This link is missing its token. Ask an administrator to send a new invitation."
      >
        <p className="text-sm text-muted">
          A valid invitation link is required to create an account.
        </p>
      </AuthShell>
    );
  }

  if (preview.isLoading) return <Spinner />;

  if (preview.error) {
    return (
      <AuthShell
        title="This invite can't be used"
        sub={preview.error.message}
      >
        <p className="text-sm text-muted">
          Ask an administrator to send a new invitation.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Join your team"
      sub={`You're joining as ${preview.data?.role} with ${preview.data?.email}.`}
    >
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="hidden">
          <UserRoundPlus className="size-5" />
        </div>
        <div>
          <p className="text-sm font-semibold">Workspace invitation</p>
          <p className="mt-1 text-xs text-muted">
            Complete your details to get started.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-5">
        <Field label="Your name">
          <Input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>

        <Field label="Password" hint="Use at least 12 characters.">
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {!!error && <ErrorNote error={error} />}

        <Button
          variant="primary"
          type="submit"
          busy={busy}
          className="w-full"
        >
          Create account
          <ArrowRight className="size-4" />
        </Button>
      </form>
    </AuthShell>
  );
}
