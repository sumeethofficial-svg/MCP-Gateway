/**
 * Everything that comes out of a cluster as free text (logs, event messages, container status
 * messages) is attacker-influenced: a request path, a User-Agent, a product name or an image tag
 * can all end up in a log line. It is returned to the model as DATA, so it is cleaned here:
 *  - terminal escapes and control characters are removed (they can hide or reorder text),
 *  - invisible and bidirectional-override characters are removed (classic hidden-prompt tricks),
 *  - every line is length-capped,
 *  - obvious credentials are masked.
 *
 * Masking is a safety net, not a guarantee: the real control is that this server's ServiceAccount
 * cannot read Secrets and that applications should not log secrets in the first place.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|\u009b[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\bsgk_[A-Za-z0-9_-]{8,}/g, "[redacted-api-key]"],
  [/\b(?:ck|cs)_[a-f0-9]{16,}/gi, "[redacted-woo-key]"],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, "$1:[redacted]@"],
  // password=..., MY_TOKEN: ..., "api_key":"..."
  [/([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]"],
];

export const MAX_LINE_CHARS = 400;

/** Cleans a single line of untrusted text. */
export function sanitizeLine(line: string, maxChars = MAX_LINE_CHARS): string {
  let out = line.replace(ANSI, "").replace(INVISIBLE, "").replace(CONTROL, "");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.trimEnd();
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

/** Cleans a multi-line blob and returns its last `maxLines` non-empty lines. */
export function sanitizeLines(text: string, maxLines: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => sanitizeLine(l))
    .filter((l) => l.length > 0);
  return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
}

/** For single-sentence free text such as an event or condition message. Collapses whitespace. */
export function sanitizeMessage(text: string | undefined, maxChars = 300): string | undefined {
  if (!text) return undefined;
  const cleaned = sanitizeLine(text.replace(/\s+/g, " ").trim(), maxChars);
  return cleaned || undefined;
}
