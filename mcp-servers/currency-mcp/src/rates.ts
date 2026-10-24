/**
 * Sample rate table. This is demo data: rates are indicative and USD-based, so the server is deterministic and
 * needs no outbound network access (and therefore no egress rule in the chart). Every result says
 * `source: "sample"` and `indicative: true` so a model or a person never mistakes it for a quote.
 * Swapping in a live provider only means replacing `perUsdAt`.
 *
 * History is a set of monthly snapshots (the latest equals the current table). The older months are an
 * illustrative, deterministic drift, not real market data.
 */
export const AS_OF = "2026-10-01";
export const SOURCE = "sample" as const;

interface Currency {
  code: string;
  name: string;
  /** How many units of this currency one USD buys today. */
  perUsd: number;
  /** Decimal places used when rounding amounts. */
  decimals: number;
  /** How far this currency drifts per month in the illustrative history (fraction). */
  volatility: number;
}

export const CURRENCIES: readonly Currency[] = [
    { code: "USD", name: "United States Dollar", perUsd: 1, decimals: 2, volatility: 0 },
  { code: "EUR", name: "Euro", perUsd: 0.8904, decimals: 2, volatility: 0.004 },
  { code: "GBP", name: "British Pound Sterling", perUsd: 0.7502, decimals: 2, volatility: 0.004 },
  { code: "INR", name: "Indian Rupee", perUsd: 94.96, decimals: 2, volatility: 0.003 },
  { code: "JPY", name: "Japanese Yen", perUsd: 158, decimals: 0, volatility: 0.008 },
  { code: "AUD", name: "Australian Dollar", perUsd: 1.4388, decimals: 2, volatility: 0.005 },
  { code: "CAD", name: "Canadian Dollar", perUsd: 1.4157, decimals: 2, volatility: 0.003 },
  { code: "SGD", name: "Singapore Dollar", perUsd: 1.2798, decimals: 2, volatility: 0.002 },
  { code: "AED", name: "United Arab Emirates Dirham", perUsd: 3.6725, decimals: 2, volatility: 0 },
  { code: "CNY", name: "Chinese Yuan Renminbi", perUsd: 6.6861, decimals: 2, volatility: 0.003 },
  { code: "CHF", name: "Swiss Franc", perUsd: 0.8243, decimals: 2, volatility: 0.004 },
];

const byCode = new Map(CURRENCIES.map((c) => [c.code, c]));

export class UnknownCurrencyError extends Error {
  constructor(code: string) {
    super(`Unknown currency "${code}". Use list_currencies to see supported codes.`);
  }
}

export class DateOutOfRangeError extends Error {}

export function currency(code: string): Currency {
  const found = byCode.get(code.toUpperCase());
  if (!found) throw new UnknownCurrencyError(code);
  return found;
}

/** Number of monthly snapshots, ending at AS_OF's month. */
const SNAPSHOT_MONTHS = 13;
const [asOfYear, asOfMonth] = AS_OF.split("-").map(Number) as [number, number];

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}
const LAST = monthIndex(asOfYear, asOfMonth);
const FIRST = LAST - (SNAPSHOT_MONTHS - 1);

/** The first day covered by history, as YYYY-MM-DD. */
export const EARLIEST = `${Math.floor(FIRST / 12)}-${String((FIRST % 12) + 1).padStart(2, "0")}-01`;

/** One USD in `code` during the given snapshot month (monthsBack = 0 is the latest). */
function perUsdAt(c: Currency, monthsBack: number): number {
  return c.perUsd * (1 - c.volatility * monthsBack);
}

export interface RateQuote {
  rate: number;
  snapshot: string;
}

function snapshotLabel(index: number): string {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Exchange rate for one unit of `from` in `to`. With no date: the latest table. With a date: that month's snapshot. */
export function rateAt(from: string, to: string, date?: string): RateQuote {
  const f = currency(from);
  const t = currency(to);
  let monthsBack = 0;
  if (date !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const parsed = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
    if (!m || !parsed || parsed.toISOString().slice(0, 10) !== date) throw new DateOutOfRangeError(`"${date}" is not a valid date; use YYYY-MM-DD.`);
    if (date > AS_OF) throw new DateOutOfRangeError(`The sample table has no rates after ${AS_OF}.`);
    if (date < EARLIEST) throw new DateOutOfRangeError(`The sample table has no rates before ${EARLIEST}.`);
    monthsBack = LAST - monthIndex(Number(m[1]), Number(m[2]));
  }
  return { rate: perUsdAt(t, monthsBack) / perUsdAt(f, monthsBack), snapshot: snapshotLabel(LAST - monthsBack) };
}

export function convert(amount: number, from: string, to: string, date?: string): { rate: number; result: number; snapshot: string } {
  const { rate, snapshot } = rateAt(from, to, date);
  const factor = 10 ** currency(to).decimals;
  return { rate, snapshot, result: Math.round(amount * rate * factor) / factor };
}
