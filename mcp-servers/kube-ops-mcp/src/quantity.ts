/** Kubernetes resource quantities, reduced to the two numbers people reason about. */

const BINARY: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
const DECIMAL: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

/** "250m" -> 250, "1" -> 1000, "12345678n" -> 12.3 (millicores). Returns undefined for anything unparseable. */
export function parseCpuMillicores(q: string | undefined): number | undefined {
  if (!q) return undefined;
  const m = /^(\d+(?:\.\d+)?)(n|u|m)?$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const mc = m[2] === "n" ? n / 1e6 : m[2] === "u" ? n / 1e3 : m[2] === "m" ? n : n * 1000;
  return Math.round(mc * 10) / 10;
}

/** "128Mi" -> 134217728, "100Ki" -> 102400, "1000000" -> 1000000 (bytes). */
export function parseBytes(q: string | undefined): number | undefined {
  if (!q) return undefined;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|K|M|G|T)?$/.exec(q.trim());
  if (!m) return undefined;
  const unit = m[2];
  const factor = unit === undefined ? 1 : (BINARY[unit] ?? DECIMAL[unit] ?? 1);
  return Math.round(Number(m[1]) * factor);
}

export const toMiB = (bytes: number): number => Math.round((bytes / 1024 ** 2) * 10) / 10;
