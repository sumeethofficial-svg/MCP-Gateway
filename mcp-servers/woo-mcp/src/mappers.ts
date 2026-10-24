/**
 * WooCommerce payloads are large and noisy. These mappers return the small,
 * stable shape a model actually needs, which keeps token usage down and keeps
 * incidental data (internal meta, customer notes, addresses) out of the model's
 * context unless explicitly requested.
 */

interface WcProduct {
  id: number;
  name: string;
  slug?: string;
  permalink?: string;
  date_created_gmt?: string | null;
  type?: string;
  status?: string;
  sku?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  stock_status?: string;
  stock_quantity?: number | null;
  manage_stock?: boolean;
}

interface WcLineItem {
  product_id: number;
  name: string;
  quantity: number;
  total: string;
  sku?: string;
}

interface WcOrder {
  id: number;
  number?: string;
  status: string;
  currency: string;
  total: string;
  date_created_gmt?: string | null;
  date_paid_gmt?: string | null;
  payment_method_title?: string;
  line_items?: WcLineItem[];
  billing?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    city?: string;
    country?: string;
  };
}

export function mapProduct(p: WcProduct) {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku || null,
    status: p.status ?? null,
    type: p.type ?? null,
    price: p.price ?? null,
    regular_price: p.regular_price ?? null,
    sale_price: p.sale_price || null,
    stock_status: p.stock_status ?? null,
    stock_quantity: p.stock_quantity ?? null,
    url: p.permalink ?? null,
    created_at: asIsoUtc(p.date_created_gmt),
  };
}

export function mapOrder(o: WcOrder, includeCustomerDetails: boolean) {
  const items = o.line_items ?? [];
  const base = {
    id: o.id,
    number: o.number ?? String(o.id),
    status: o.status,
    total: o.total,
    currency: o.currency,
    created_at: asIsoUtc(o.date_created_gmt),
    paid_at: asIsoUtc(o.date_paid_gmt),
    payment_method: o.payment_method_title ?? null,
    item_count: items.reduce((sum, item) => sum + item.quantity, 0),
    items: items.map((item) => ({
      product_id: item.product_id,
      name: item.name,
      quantity: item.quantity,
      total: item.total,
    })),
  };
  if (!includeCustomerDetails) return base;
  const b = o.billing ?? {};
  return {
    ...base,
    customer: {
      name: [b.first_name, b.last_name].filter(Boolean).join(" ") || null,
      email: b.email || null,
      phone: b.phone || null,
      city: b.city || null,
      country: b.country || null,
    },
  };
}

function asIsoUtc(value: string | null | undefined): string | null {
  if (!value) return null;
  // WooCommerce *_gmt fields are UTC without a zone designator.
  return /Z|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
}

/** Statuses that represent real revenue for summary purposes. */
export const REVENUE_STATUSES = new Set(["processing", "completed", "on-hold"]);

/** Decimal string to integer minor units, avoiding float drift when summing. */
export function toMinorUnits(amount: string): number {
  const n = Number.parseFloat(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function fromMinorUnits(minor: number): string {
  return (minor / 100).toFixed(2);
}
