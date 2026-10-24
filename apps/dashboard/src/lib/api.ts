export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
     ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "x-requested-with": "mcp-portal",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? safeParse(text) : undefined;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}
const safeParse = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

export const get = <T,>(p: string) => api<T>("GET", p);
export const post = <T,>(p: string, b?: unknown) => api<T>("POST", p, b ?? {});
export const patch = <T,>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const del = <T,>(p: string) => api<T>("DELETE", p);

export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
