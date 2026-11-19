import { DurableObject } from 'cloudflare:workers';
import type { WorktreeMutexLease } from '@gitvise/core';

const LEASE_KEY = 'lease';
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 3_600_000;

/**
 * Single-writer lock for one worktree. One Durable Object per `worktreeId`, so the platform serialises
 * RPCs to it. A lease expires on its own, so a crashed holder cannot block the worktree.
 *
 * The check-and-set in `acquire` and `release` uses the synchronous KV API with no `await` in between. An
 * asynchronous read followed by a write would let two acquires both see "free" and both win.
 */
export class WorktreeMutex extends DurableObject<unknown> {
  /** Returns null when another owner holds an unexpired lease. Never blocks. */
  async acquire(worktreeId: string, owner: string, ttlMs: number): Promise<WorktreeMutexLease | null> {
    const now = Date.now();
    const held = this.ctx.storage.kv.get<WorktreeMutexLease>(LEASE_KEY);
    if (held !== undefined && held.expiresAtMs > now) return null;

    const ttl = Math.min(Math.max(Math.floor(ttlMs), MIN_TTL_MS), MAX_TTL_MS);
    const lease: WorktreeMutexLease = {
      worktreeId,
      owner,
      token: crypto.randomUUID(),
      expiresAtMs: now + ttl,
    };
    this.ctx.storage.kv.put(LEASE_KEY, lease);
    await this.ctx.storage.setAlarm(lease.expiresAtMs);
    return lease;
  }

  /** Releases only when the token matches and the lease has not expired. */
  async release(token: string): Promise<boolean> {
    const held = this.ctx.storage.kv.get<WorktreeMutexLease>(LEASE_KEY);
    if (held === undefined || held.token !== token || held.expiresAtMs <= Date.now()) return false;
    this.ctx.storage.kv.delete(LEASE_KEY);
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  /** Clears the stored lease once it expires, so storage does not keep stale state. */
  override async alarm(): Promise<void> {
    const held = this.ctx.storage.kv.get<WorktreeMutexLease>(LEASE_KEY);
    if (held !== undefined && held.expiresAtMs <= Date.now()) {
      this.ctx.storage.kv.delete(LEASE_KEY);
    }
  }
}
