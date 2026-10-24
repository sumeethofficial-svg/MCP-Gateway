const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 45) return "just now";
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
export const num = (n: number) => n.toLocaleString();
export const pct = (a: number, b: number) => (b === 0 ? "0%" : `${((a / b) * 100).toFixed(a / b < 0.1 ? 1 : 0)}%`);
export async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  // Plain-http fallback. The textarea must live inside the open <dialog>, because everything outside a
  // modal dialog is inert and could not be focused or selected.
  const host = (document.activeElement?.closest("dialog") as HTMLElement | null) ?? document.body;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  host.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  host.removeChild(ta);
  return ok;
}