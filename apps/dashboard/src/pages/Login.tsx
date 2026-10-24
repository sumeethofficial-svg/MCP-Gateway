import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { post } from "../lib/api";
import { ErrorNote } from "../components/ui";

export function AuthShell({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 py-10 text-ink">
      <section className="w-full max-w-md border border-ink">
        <div className="flex items-center justify-between border-b border-ink bg-ink px-4 py-2 text-bg">
          <span className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em]">
            <span className="size-2.5 bg-accent" aria-hidden />
            MCP//Portal
          </span>
          <span className="text-[10px] uppercase tracking-wider opacity-70">
            Access terminal
          </span>
        </div>

        <div className="p-6 sm:p-8">
          <h1 className="text-xl">
            {title === "Sign in" ? "Authenticate" : title}
          </h1>
          <p className="mb-7 mt-2 text-[12px] leading-relaxed text-muted">
            {sub}
          </p>

          {children}
        </div>

        <div className="border-t border-line px-4 py-2 text-[10px] uppercase tracking-wider text-muted">
          One gateway · per-user keys · every call audited
        </div>
      </section>
    </main>
  );
}

const input =
  "h-10 w-full border border-line bg-bg px-3 text-[13px] text-ink outline-none transition placeholder:text-muted/60 hover:border-ink focus:border-accent focus:ring-1 focus:ring-accent";

export function Login() {
  const qc = useQueryClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();

    if (busy) return;

    setBusy(true);
    setError(undefined);

    try {
      await post("/api/auth/login", { email, password });
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Sign in"
      sub="Use the account your administrator created for you."
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label
            htmlFor="login-email"
            className="block text-[11px] uppercase tracking-wider text-muted"
          >
            Email
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className={input}
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="login-password"
            className="block text-[11px] uppercase tracking-wider text-muted"
          >
            Password
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={input}
          />
        </div>

        {!!error && (
          <div className="border border-bad/50 bg-bad-soft p-3 text-[12px] text-bad">
            <ErrorNote error={error} />
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="flex h-10 w-full items-center justify-center bg-ink px-5 text-[12px] font-semibold uppercase tracking-wider text-bg transition hover:bg-accent hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in →"}
        </button>

        <p className="border-t border-line pt-4 text-[12px] text-muted">
          New here? Ask your administrator for an invitation.
        </p>
      </form>
    </AuthShell>
  );
}
