export const DATE_PRESETS = ["today", "yesterday", "last_7_days", "this_month"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export interface DateRange {
  /** Inclusive start, UTC ISO-8601. */
  after: string;
  /** Exclusive end, UTC ISO-8601. */
  before: string;
  /** Human-readable label echoed back so the model can quote the window it used. */
  label: string;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(instant: Date, timeZone: string): Parts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = Number.parseInt(part.value, 10);
  }
  return {
    year: map.year!,
    month: map.month!,
    day: map.day!,
    hour: map.hour!,
    minute: map.minute!,
    second: map.second!,
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. Positive east of Greenwich. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which local calendar day (y, m, d) begins in `timeZone`. Handles DST shifts. */
function startOfLocalDay(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = naive - offsetMs(new Date(naive), timeZone);
  const corrected = naive - offsetMs(new Date(guess), timeZone);
  if (corrected !== guess) guess = corrected;
  return new Date(guess);
}

function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function label(startInstant: Date, endInstant: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const last = new Date(endInstant.getTime() - 1);
  const from = fmt.format(startInstant);
  const to = fmt.format(last);
  return from === to ? `${from} (${timeZone})` : `${from} to ${to} (${timeZone})`;
}

/** Resolves a named window to concrete UTC bounds using the store's calendar, not the server's. */
export function resolvePreset(preset: DatePreset, timeZone: string, now: Date = new Date()): DateRange {
  const today = partsInZone(now, timeZone);
  let start: Date;
  let end: Date;

  switch (preset) {
    case "today": {
      const next = addDays(today.year, today.month, today.day, 1);
      start = startOfLocalDay(today.year, today.month, today.day, timeZone);
      end = startOfLocalDay(next.year, next.month, next.day, timeZone);
      break;
    }
    case "yesterday": {
      const prev = addDays(today.year, today.month, today.day, -1);
      start = startOfLocalDay(prev.year, prev.month, prev.day, timeZone);
      end = startOfLocalDay(today.year, today.month, today.day, timeZone);
      break;
    }
    case "last_7_days": {
      const first = addDays(today.year, today.month, today.day, -6);
      const next = addDays(today.year, today.month, today.day, 1);
      start = startOfLocalDay(first.year, first.month, first.day, timeZone);
      end = startOfLocalDay(next.year, next.month, next.day, timeZone);
      break;
    }
    case "this_month": {
      const nextMonth = addDays(today.year, today.month, 1, 32);
      start = startOfLocalDay(today.year, today.month, 1, timeZone);
      end = startOfLocalDay(nextMonth.year, nextMonth.month, 1, timeZone);
      break;
    }
  }
  return { after: start.toISOString(), before: end.toISOString(), label: label(start, end, timeZone) };
}
