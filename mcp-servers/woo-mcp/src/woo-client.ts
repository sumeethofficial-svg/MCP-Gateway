import type { WooConfig } from "./config.js";

export type WooErrorKind = "auth" | "not_found" | "validation" | "unavailable" | "timeout" | "unknown";

/** An error whose message is safe to show to an LLM or a human (no secrets, no stack). */
export class WooError extends Error {
  constructor(
    public readonly kind: WooErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WooError";
  }
}

export interface WooPage<T> {
  items: T;
  total: number | undefined;
  totalPages: number | undefined;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** Statuses worth one retry on idempotent reads (gateway/proxy hiccups while WordPress warms up). */
const RETRYABLE = new Set([502, 503, 504]);

/**
 * Minimal WooCommerce REST v3 client.
 *
 * Why REST (and not WP-CLI or direct SQL)? See docs/DESIGN.md. In short: it is
 * the supported, versioned API; it is least-privilege through a scoped consumer
 * key; and it needs no exec access into the WordPress pod.
 *
 * Why `/wp-json/` and not `/?rest_route=`? Verified against a live WooCommerce: with pretty permalinks on, the
 * `rest_route` form is served but WooCommerce's Basic-auth handler does not recognise it as an API request, so the
 * key is ignored and every call is a 401. `/wp-json/` authenticates correctly. The Helm setup Job enables pretty
 * permalinks, so the prefix is always routable.
 */
export class WooClient {
  private readonly authorization: string;

  constructor(
    private readonly config: Pick<WooConfig, "baseUrl" | "consumerKey" | "consumerSecret" | "timeoutMs">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.authorization = "Basic " + Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
  }

  async get<T>(path: string, opts: RequestOptions = {}): Promise<WooPage<T>> {
    return this.send<T>("GET", path, opts, true);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.send<T>("POST", path, { body }, false)).items;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return (await this.send<T>("PUT", path, { body }, false)).items;
  }

  async delete<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.send<T>("DELETE", path, opts, false)).items;
  }
  /** Authenticated round trip. Proves the consumer key works; used for diagnostics, not for readiness. */
  async ping(): Promise<void> {
    await this.get("/products", { query: { per_page: 1 } });
  }

  /**
   * Readiness: is WordPress answering HTTP at all? Any response counts, including a redirect to the installer, except a gateway error (502/503/504).
   * Credentials are deliberately NOT part of readiness. In a fresh install the API key is created by a Job that
   * runs after the Deployments are ready, so requiring it here would deadlock `helm install --wait`.
   * A bad key still surfaces on the first tool call as a clear "auth" error.
   */
  async reachable(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.config.baseUrl + "/", { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(this.config.timeoutMs) });
      if (RETRYABLE.has(res.status)) throw new WooError("unavailable", `WooCommerce is unavailable (HTTP ${res.status}).`, res.status);
    } catch (err) {
      throw err instanceof WooError ? err : mapNetworkError(err);
    }
  }

  private buildUrl(path: string, query: RequestOptions["query"]): string {
    const url = new URL(`${this.config.baseUrl}/wp-json/wc/v3${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async send<T>(method: string, path: string, opts: RequestOptions, idempotent: boolean): Promise<WooPage<T>> {
    const url = this.buildUrl(path, opts.query);
    const attempts = idempotent ? 2 : 1;
    let lastError: WooError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: {
            authorization: this.authorization,
            accept: "application/json",
            // WooCommerce only accepts key/secret Basic auth over HTTPS. Inside the
            // cluster we speak plain HTTP to WordPress, and wp-config.php honours
            // this header (the same mechanism TLS-terminating ingresses use).
            "x-forwarded-proto": "https",
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });

        if (res.ok) {
          const text = await res.text();
          let items: unknown;
          try {
            items = text ? JSON.parse(text) : null;
          } catch {
            throw new WooError("unknown", "WooCommerce returned a response that is not JSON. Is the store URL pointing at WordPress?");
          }
          return {
            items: items as T,
            total: numberHeader(res.headers.get("x-wp-total")),
            totalPages: numberHeader(res.headers.get("x-wp-totalpages")),
          };
        }

        const error = await this.mapHttpError(res);
        if (idempotent && RETRYABLE.has(res.status) && attempt < attempts) {
          lastError = error;
          await sleep(250);
          continue;
        }
        throw error;
      } catch (err) {
        if (err instanceof WooError) throw err;
        const mapped = mapNetworkError(err);
        if (idempotent && attempt < attempts && mapped.kind !== "timeout") {
          lastError = mapped;
          await sleep(250);
          continue;
        }
        throw mapped;
      }
    }
    throw lastError ?? new WooError("unknown", "Request failed");
  }

  private async mapHttpError(res: Response): Promise<WooError> {
    let wcMessage: string | undefined;
    try {
      const data = (await res.json()) as { message?: unknown };
      if (typeof data.message === "string") wcMessage = stripHtml(data.message).slice(0, 300);
    } catch {
      /* body was not JSON */
    }
    switch (res.status) {
      case 401:
      case 403:
        return new WooError("auth", `WooCommerce rejected the API credentials (HTTP ${res.status}). The consumer key may be revoked or lack read/write permission.`, res.status);
      case 404:
        return new WooError("not_found", wcMessage ?? "Not found in WooCommerce.", 404);
      case 400:
      case 422:
        return new WooError("validation", wcMessage ?? "WooCommerce rejected the request as invalid.", res.status);
      default:
        if (res.status >= 500) return new WooError("unavailable", `WooCommerce is unavailable (HTTP ${res.status}).`, res.status);
        return new WooError("unknown", wcMessage ?? `Unexpected response from WooCommerce (HTTP ${res.status}).`, res.status);
    }
  }
}

function mapNetworkError(err: unknown): WooError {
  const name = (err as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new WooError("timeout", "WooCommerce did not respond in time.");
  }
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new WooError("unavailable", "Cannot resolve the WooCommerce host (DNS).");
  if (code === "ECONNREFUSED") return new WooError("unavailable", "WooCommerce refused the connection. Is WordPress running?");
  return new WooError("unavailable", "Cannot reach WooCommerce.");
}

function numberHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
