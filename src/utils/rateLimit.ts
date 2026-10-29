/** Tiny fixed-window in-memory rate limiter (single instance app). */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true when the call is allowed. */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 10_000) {
        const oldest = this.hits.keys().next().value;
        if (oldest !== undefined) this.hits.delete(oldest);
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}
