/**
 * Small bounded in-memory map used as a fallback when Firestore is unavailable
 * (errors, quota exhaustion). Writes always land here; reads use it only when
 * the Firestore read fails, so agents keep seeing recent drafts and summaries
 * produced by this process during an outage. Lost on restart by design.
 */
export class MemoryFallback<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxEntries = 2000) {}

  set(key: string | number, value: V): void {
    const k = String(key);
    this.entries.delete(k);
    this.entries.set(k, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(key: string | number): V | null {
    return this.entries.get(String(key)) ?? null;
  }
}
