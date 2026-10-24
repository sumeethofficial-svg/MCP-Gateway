export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Fixed-window counter. In-memory, so each gateway replica enforces the limit
 * independently: with N replicas the effective ceiling is N x limit. That tradeoff is
 * documented in docs/DESIGN.md; a shared store (Redis, or Postgres) would make it exact.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): RateDecision {
    const now = this.now();
    this.sweep(now);
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, entry);
    }
    if (entry.count >= this.limit) return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
    entry.count += 1;
    return { allowed: true, remaining: this.limit - entry.count, retryAfterMs: 0 };
  }

  /** Clears a key, e.g. after a successful login. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(key);
  }
}
