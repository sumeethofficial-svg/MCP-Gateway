import { Check, Copy, Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { copy } from "../lib/format";

const cx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(" ");
export { cx };

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110 border-transparent",
  secondary: "bg-raised text-ink border-line hover:border-muted",
  ghost: "bg-transparent text-muted hover:text-ink hover:bg-raised border-transparent",
  danger: "bg-raised text-bad border-line hover:border-bad",
};
export function Button({ variant = "secondary", busy, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx("inline-flex items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed", variants[variant], className)}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const field = "w-full rounded-md border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-accent";
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(field, props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(field, "pr-8", props.className)} />;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-lg border border-line bg-surface", className)}>{children}</section>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl">{title}</h1>
        {sub && <p className="mt-1 max-w-prose text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

const tones = {
  neutral: "bg-raised text-muted border-line",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  bad: "bg-bad-soft text-bad border-transparent",
  accent: "bg-ink text-bg border-transparent",
};
export function Badge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

/** Status lamp: colour is never the only signal, the label is always shown. */
export function Lamp({ status }: { status: string }) {
  const map: Record<string, [string, string, boolean]> = {
    connected: ["bg-ok", "Connected", false],
    unreachable: ["bg-bad", "Unreachable", true],
    disabled: ["bg-muted/50", "Disabled", false],
    pending: ["bg-warn", "Checking", true],
    unknown: ["bg-warn", "Not checked yet", false],
  };
  const [dot, label, pulse] = map[status] ?? map.unknown!;
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <span className={cx("size-2.5 rounded-full", dot, pulse && "pulse")} aria-hidden />
      {label}
    </span>
  );
}

/** `fx__search` rendered as a namespace plus a tool: the namespace is what makes collisions harmless. */
export function ToolName({ name, className }: { name: string; className?: string }) {
  const i = name.indexOf("__");
  if (i < 0) return <code className={cx("font-mono text-[13px]", className)}>{name}</code>;
  if (i === name.length - 2)
    return (
      <code className={cx("font-mono text-[13px] whitespace-nowrap", className)}>
        <span className="rounded-sm bg-raised px-1 py-px text-ink">{name.slice(0, i)}</span>
        <span className="text-muted">/*</span>
      </code>
    );
  return (
    <code className={cx("font-mono text-[13px] whitespace-nowrap", className)}>
      <span className="rounded-sm bg-raised px-1 py-px text-ink">{name.slice(0, i)}</span>
      <span className="text-muted">/</span>
      <span className="font-medium">{name.slice(i + 2)}</span>
    </code>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="font-display text-lg">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}…
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <div role="alert" className="rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-bad">
      {error instanceof Error ? error.message : "Something went wrong"}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        if (await copy(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        }
      }}
    >
      {done ? <Check className="size-4 text-ok" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {done ? "Copied" : label}
    </Button>
  );
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cx("dialog-in m-auto w-[calc(100%-2rem)] rounded-sm border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/50", wide ? "max-w-3xl" : "max-w-lg")}
    >
      {open && (
        <div>
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="text-lg">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:text-ink">
              <X className="size-5" />
            </button>
          </div>
          <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

// ---- toasts -----------------------------------------------------------------
type Toast = { id: number; text: string; tone: "ok" | "bad" };
const ToastCtx = createContext<(text: string, tone?: "ok" | "bad") => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((t) => [...t, { id, text, tone }]);
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx("dialog-in rounded-md border px-3 py-2 text-sm shadow-lg", t.tone === "ok" ? "border-ok/40 bg-ok-soft text-ok" : "border-bad/40 bg-bad-soft text-bad")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={cx("whitespace-nowrap border-b border-line px-4 py-2 text-xs font-medium text-muted", className)}>{children}</th>
);
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={cx("border-b border-line/60 px-4 py-3 align-middle", className)}>{children}</td>;
