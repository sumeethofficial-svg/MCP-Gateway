import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fail, ok, READ_ONLY, WRITE } from "@mcp-portal/mcp-kit";
import type { Logger } from "pino";
import { z } from "zod";
import type { WooConfig } from "./config.js";
import { DATE_PRESETS, resolvePreset, type DateRange } from "./dates.js";
import { fromMinorUnits, mapOrder, mapProduct, REVENUE_STATUSES, toMinorUnits } from "./mappers.js";
import { WooClient, WooError } from "./woo-client.js";

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

/** Decimal price like "19", "19.9" or "19.99". Accepts numbers too because models often send them. */
const price = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(v), "Price must be a non-negative decimal with at most 2 decimal places, e.g. 19.99");

const pagination = {
  per_page: z.number().int().min(1).max(50).default(20).describe("Results per page (max 50)"),
  page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
};

const customerFlag = z
  .boolean()
  .default(false)
  .describe("Include customer name, email, phone and city. Off by default to protect customer privacy; enable only when needed.");

const dateWindow = {
  date_preset: z.enum(DATE_PRESETS).optional().describe("Named window in the store's time zone. Prefer this over after/before."),
  after: z.iso.datetime({ offset: true }).optional().describe("Only orders created at or after this ISO-8601 timestamp"),
  before: z.iso.datetime({ offset: true }).optional().describe("Only orders created before this ISO-8601 timestamp"),
};

export function registerWooTools(server: McpServer, client: WooClient, config: Pick<WooConfig, "timezone" | "storeName">, log: Logger): void {
  /** Resolves the preset/explicit window, rejecting contradictory input. */
  function resolveWindow(input: { date_preset?: (typeof DATE_PRESETS)[number]; after?: string; before?: string }): DateRange | { after?: string; before?: string } {
    if (input.date_preset) {
      if (input.after || input.before) throw new WooError("validation", "Use either date_preset or after/before, not both.");
      return resolvePreset(input.date_preset, config.timezone);
    }
    return { after: input.after, before: input.before };
  }

  async function guarded(tool: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof WooError) {
        log.warn({ tool, kind: err.kind, status: err.status }, "tool failed");
        return fail(err.message);
      }
      log.error({ tool, err: (err as Error).message }, "unexpected tool error");
      return fail("Unexpected error while talking to WooCommerce.");
    }
  }

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List products in the WooCommerce store, newest first. Prices are strings in the store currency.",
      inputSchema: {
        search: z.string().max(100).optional().describe("Match against product name, SKU or description"),
        status: z.enum(["any", "publish", "draft", "pending", "private"]).default("any").describe("Publication status filter"),
        ...pagination,
      },
      annotations: READ_ONLY,
    },
    ({ search, status, per_page, page }) =>
      guarded("list_products", async () => {
        const res = await client.get<Parameters<typeof mapProduct>[0][]>("/products", {
          query: { search, status, per_page, page, orderby: "date", order: "desc" },
        });
        return ok({
          store: config.storeName,
          products: res.items.map(mapProduct),
          page,
          total: res.total ?? res.items.length,
          total_pages: res.totalPages ?? 1,
        });
      }),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Get one product by its numeric ID.",
      inputSchema: { id: z.number().int().positive().describe("Product ID") },
      annotations: READ_ONLY,
    },
    ({ id }) =>
      guarded("get_product", async () => {
        const res = await client.get<Parameters<typeof mapProduct>[0]>(`/products/${id}`);
        return ok({ store: config.storeName, product: mapProduct(res.items) });
      }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a simple product. It is published immediately by default and appears on the storefront. " +
        "Not idempotent: calling it twice creates two products, so check list_products first if unsure.",
      inputSchema: {
        name: z.string().trim().min(1).max(200).describe("Product name"),
        regular_price: price.describe("Price as a decimal, e.g. 19.99"),
        description: z.string().max(5000).optional().describe("Long description (plain text)"),
        sku: z.string().trim().max(100).optional().describe("Unique SKU"),
        status: z.enum(["publish", "draft"]).default("publish").describe("Use draft to keep it off the storefront"),
        stock_quantity: z.number().int().min(0).max(1_000_000).optional().describe("Enable stock tracking with this quantity"),
      },
      annotations: WRITE,
    },
    ({ name, regular_price, description, sku, status, stock_quantity }) =>
      guarded("create_product", async () => {
        const created = await client.post<Parameters<typeof mapProduct>[0]>("/products", {
          name,
          type: "simple",
          status,
          regular_price,
          ...(description ? { description } : {}),
          ...(sku ? { sku } : {}),
          ...(stock_quantity !== undefined ? { manage_stock: true, stock_quantity } : {}),
        });
        return ok({ store: config.storeName, product: mapProduct(created) });
      }),
  );
  server.registerTool(
    "remove_product",
    {
      title: "Remove product",
      description:
        "Remove a product from the store by its numeric ID. By default the product is moved to the WooCommerce trash (recoverable) and disappears from the storefront. " +
        "Set permanent=true only if the user explicitly asks for permanent deletion. This is destructive: confirm which product with the user first, " +
        "and use list_products to find the correct ID (there can be several products with similar names).",
      inputSchema: {
        id: z.number().int().positive().describe("Product ID (from list_products)"),
        permanent: z.boolean().default(false).describe("true = delete forever, false = move to trash"),
      },
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    ({ id, permanent }) =>
      guarded("remove_product", async () => {
        const removed = await client.delete<Parameters<typeof mapProduct>[0]>(`/products/${id}`, { query: { force: permanent } });
        return ok({ store: config.storeName, removed: true, permanent, product: mapProduct(removed) });
      }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first. For questions like 'orders today' pass date_preset instead of computing dates. " +
        "Totals are strings in the order currency.",
      inputSchema: {
        status: z.enum(["any", ...ORDER_STATUSES]).default("any").describe("Order status filter"),
        ...dateWindow,
        include_customer_details: customerFlag,
        ...pagination,
      },
      annotations: READ_ONLY,
    },
    ({ status, date_preset, after, before, include_customer_details, per_page, page }) =>
      guarded("list_orders", async () => {
        const window = resolveWindow({ date_preset, after, before });
        const res = await client.get<Parameters<typeof mapOrder>[0][]>("/orders", {
          query: { status, after: window.after, before: window.before, dates_are_gmt: true, per_page, page, orderby: "date", order: "desc" },
        });
        return ok({
          store: config.storeName,
          window: "label" in window ? window.label : null,
          orders: res.items.map((o) => mapOrder(o, include_customer_details)),
          page,
          total: res.total ?? res.items.length,
          total_pages: res.totalPages ?? 1,
        });
      }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order by its numeric ID, including line items.",
      inputSchema: { id: z.number().int().positive().describe("Order ID"), include_customer_details: customerFlag },
      annotations: READ_ONLY,
    },
    ({ id, include_customer_details }) =>
      guarded("get_order", async () => {
        const res = await client.get<Parameters<typeof mapOrder>[0]>(`/orders/${id}`);
        return ok({ store: config.storeName, order: mapOrder(res.items, include_customer_details) });
      }),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description:
        "Change an order's status (for example processing to completed). This can trigger customer emails and stock changes in WooCommerce.",
      inputSchema: {
        id: z.number().int().positive().describe("Order ID"),
        status: z.enum(ORDER_STATUSES).describe("New status"),
        note: z.string().max(500).optional().describe("Optional private note recorded on the order"),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ id, status, note }) =>
      guarded("update_order_status", async () => {
        const updated = await client.put<Parameters<typeof mapOrder>[0]>(`/orders/${id}`, { status });
        if (note) await client.post(`/orders/${id}/notes`, { note, customer_note: false });
        return ok({ store: config.storeName, order: mapOrder(updated, false) });
      }),
  );

  server.registerTool(
    "sales_summary",
    {
      title: "Sales summary",
      description:
        "Count orders and total revenue for a time window, grouped by status. Revenue counts processing, completed and on-hold orders. " +
        "Use this to compare stores or days instead of listing every order.",
      inputSchema: {
        date_preset: z.enum(DATE_PRESETS).default("today").describe("Named window in the store's time zone"),
      },
      annotations: READ_ONLY,
    },
    ({ date_preset }) =>
      guarded("sales_summary", async () => {
        const window = resolvePreset(date_preset, config.timezone);
        const MAX_PAGES = 5;
        const PER_PAGE = 100;
        const byStatus: Record<string, number> = {};
        let revenueMinor = 0;
        let counted = 0;
        let currency: string | null = null;
        let truncated = false;

        for (let page = 1; page <= MAX_PAGES; page++) {
          const res = await client.get<Parameters<typeof mapOrder>[0][]>("/orders", {
            query: { status: "any", after: window.after, before: window.before, dates_are_gmt: true, per_page: PER_PAGE, page },
          });
          for (const order of res.items) {
            counted += 1;
            currency ??= order.currency;
            byStatus[order.status] = (byStatus[order.status] ?? 0) + 1;
            if (REVENUE_STATUSES.has(order.status)) revenueMinor += toMinorUnits(order.total);
          }
          if (page >= (res.totalPages ?? 1)) break;
          if (page === MAX_PAGES) truncated = true;
        }

        return ok({
          store: config.storeName,
          window: window.label,
          order_count: counted,
          revenue: fromMinorUnits(revenueMinor),
          currency,
          by_status: byStatus,
          truncated,
        });
      }),
  );
}
