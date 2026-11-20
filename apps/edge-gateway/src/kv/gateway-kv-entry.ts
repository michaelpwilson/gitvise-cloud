import { DurableObject } from 'cloudflare:workers';

/**
 * One key's value, held in its own Durable Object. Each operation runs without an `await`, so it is atomic against
 * every other request to the same key. That is what `ifAbsent`, counters, and expiry need.
 *
 * Workers KV cannot do this. A KV namespace is eventually consistent, so two writers can both see a key as absent.
 * Keys are addressed by name, so no shared table is needed.
 *
 * Expiry is checked on access. A key past its `expiresAt` is treated as absent and removed when touched. No alarm
 * runs, so a key nobody reads keeps its storage until it is touched. That is a bounded cost, because each key
 * holds one small value.
 */

const ENTRY = 'entry';

interface StoredEntry {
  readonly value: string;
  /** Epoch milliseconds. Absent for a key with no expiry. */
  readonly expiresAt?: number;
}

export class GatewayKvEntry extends DurableObject<unknown> {
  /** Returns the value, or undefined when the key is absent or expired. */
  get(): string | undefined {
    return this.live(Date.now())?.value;
  }

  /**
   * Writes the value. With `ifAbsent`, writes only when the key is absent or expired, and returns false when a live
   * value is already there. A `ttlMs` sets an expiry for this write.
   */
  put(value: string, options: { readonly ttlMs?: number; readonly ifAbsent?: boolean } = {}): boolean {
    const now = Date.now();
    if (options.ifAbsent === true && this.live(now) !== undefined) return false;
    this.write({ value, ...(options.ttlMs === undefined ? {} : { expiresAt: now + options.ttlMs }) });
    return true;
  }

  /** Removes the key. Returns whether a live value was removed. */
  delete(): boolean {
    return this.remove(Date.now());
  }

  /** Reads and removes the value in one step. Returns undefined when the key is absent or expired. */
  take(): string | undefined {
    const now = Date.now();
    const value = this.live(now)?.value;
    if (value !== undefined) this.ctx.storage.kv.delete(ENTRY);
    return value;
  }

  /**
   * Adds `by` to an integer counter, creating it at zero when absent. A counter created here expires after `ttlMs`
   * when that is given. An existing expiry is kept. Returns the new value.
   */
  increment(by: number, ttlMs?: number): number {
    const now = Date.now();
    const current = this.live(now);
    const base = current === undefined ? 0 : parseCounter(current.value);
    const next = base + by;
    if (!Number.isSafeInteger(next)) throw new RangeError('counter would leave the safe integer range');
    if (current === undefined) {
      this.write({ value: String(next), ...(ttlMs === undefined ? {} : { expiresAt: now + ttlMs }) });
    } else {
      this.write({ value: String(next), ...(current.expiresAt === undefined ? {} : { expiresAt: current.expiresAt }) });
    }
    return next;
  }

  /** Remaining lifetime in ms: -2 when the key is absent, -1 when it has no expiry. */
  remainingMs(): number {
    const now = Date.now();
    const entry = this.live(now);
    if (entry === undefined) return -2;
    if (entry.expiresAt === undefined) return -1;
    return entry.expiresAt - now;
  }

  /** Sets an expiry on a live key. Returns false when the key is absent or expired. */
  expire(ttlMs: number): boolean {
    const now = Date.now();
    const entry = this.live(now);
    if (entry === undefined) return false;
    this.write({ value: entry.value, expiresAt: now + ttlMs });
    return true;
  }

  private live(now: number): StoredEntry | undefined {
    const entry = this.ctx.storage.kv.get<StoredEntry>(ENTRY);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
      this.ctx.storage.kv.delete(ENTRY);
      return undefined;
    }
    return entry;
  }

  private write(entry: StoredEntry): void {
    this.ctx.storage.kv.put(ENTRY, entry);
  }

  private remove(now: number): boolean {
    return this.live(now) !== undefined && this.ctx.storage.kv.delete(ENTRY);
  }
}

function parseCounter(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('value is not an integer counter');
  return parsed;
}
