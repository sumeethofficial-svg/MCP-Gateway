import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fail, ok, READ_ONLY } from "@mcp-portal/mcp-kit";
import { z } from "zod";
import { AS_OF, convert, CURRENCIES, DateOutOfRangeError, EARLIEST, rateAt, SOURCE, UnknownCurrencyError } from "./rates.js";

const code = z.string().trim().length(3).describe("ISO 4217 currency code, e.g. INR");
const date = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe(`Date as YYYY-MM-DD, from ${EARLIEST} to ${AS_OF}`);

/** Every result says where the number came from, so it is never mistaken for a market quote. */
const provenance = { source: SOURCE, indicative: true } as const;

function guarded(run: () => CallToolResult): CallToolResult {
  try {
    return run();
  } catch (err) {
    if (err instanceof UnknownCurrencyError || err instanceof DateOutOfRangeError) return fail(err.message);
    return fail("Unexpected error in currency-mcp.");
  }
}

const round = (n: number) => Number(n.toPrecision(8));

export function registerCurrencyTools(server: McpServer): void {
  server.registerTool(
    "get_exchange_rate",
    {
      title: "Get exchange rate",
      description: "Get the current exchange rate for one unit of `from` expressed in `to` (indicative sample rates).",
      inputSchema: { from: code, to: code },
      annotations: READ_ONLY,
    },
    ({ from, to }) =>
      guarded(() => {
        const q = rateAt(from, to);
        return ok({ from: from.toUpperCase(), to: to.toUpperCase(), rate: round(q.rate), as_of: AS_OF, ...provenance });
      }),
  );

  server.registerTool(
    "convert_currency",
    {
      title: "Convert currency",
      description:
        "Convert an amount between two currencies, for example a product price or an order total. Amounts are rounded to the target currency's precision (indicative sample rates).",
      inputSchema: { amount: z.number().finite().min(0).max(1e12).describe("Amount in the source currency"), from: code, to: code },
      annotations: READ_ONLY,
    },
    ({ amount, from, to }) =>
      guarded(() => {
        const { rate, result } = convert(amount, from, to);
        return ok({ amount, from: from.toUpperCase(), to: to.toUpperCase(), rate: round(rate), result, as_of: AS_OF, ...provenance });
      }),
  );

  server.registerTool(
    "get_historical_rate",
    {
      title: "Get historical exchange rate",
      description: `Get the exchange rate for one unit of \`from\` in \`to\` for a past date (${EARLIEST} to ${AS_OF}). History is stored as monthly snapshots, so any day in a month returns that month's rate (illustrative sample data).`,
      inputSchema: { from: code, to: code, date },
      annotations: READ_ONLY,
    },
    ({ from, to, date: d }) =>
      guarded(() => {
        const q = rateAt(from, to, d);
        return ok({ from: from.toUpperCase(), to: to.toUpperCase(), date: d, rate: round(q.rate), snapshot: q.snapshot, ...provenance });
      }),
  );

  server.registerTool(
    "list_currencies",
    { title: "List currencies", description: "List all supported currency codes and names.", inputSchema: {}, annotations: READ_ONLY },
    () => ok({ currencies: CURRENCIES.map(({ code: c, name, decimals }) => ({ code: c, name, decimals })), as_of: AS_OF, ...provenance }),
  );
}
