import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WorktreeMutexLease } from '@gitvise/core';
import { testEnv, uniqueId } from './support/bindings';

const LEASE_KEY = 'lease';

describe('WorktreeMutex', () => {
  it('grants the lock to the first owner and refuses a second while the lease is live', async () => {
    const worktreeId = uniqueId('wt');
    const stub = testEnv.WORKTREE_MUTEX.getByName(worktreeId);

    const first = await stub.acquire(worktreeId, 'agent-a', 60_000);
    expect(first).not.toBeNull();
    expect(first?.owner).toBe('agent-a');

    // Never blocks: a contended acquire returns null straight away.
    expect(await stub.acquire(worktreeId, 'agent-b', 60_000)).toBeNull();
  });

  it('releases only with the token that acquired the lock', async () => {
    const worktreeId = uniqueId('wt');
    const stub = testEnv.WORKTREE_MUTEX.getByName(worktreeId);
    const lease = await stub.acquire(worktreeId, 'agent-a', 60_000);
    if (lease === null) throw new Error('expected the lock to be free');

    expect(await stub.release('not-the-token')).toBe(false);
    expect(await stub.acquire(worktreeId, 'agent-b', 60_000)).toBeNull();

    expect(await stub.release(lease.token)).toBe(true);
    // A second release with the same token is a no-op.
    expect(await stub.release(lease.token)).toBe(false);

    const next = await stub.acquire(worktreeId, 'agent-b', 60_000);
    expect(next?.owner).toBe('agent-b');
  });

  it('lets a new owner take the lock once the previous lease has expired', async () => {
    const worktreeId = uniqueId('wt');
    const stub = testEnv.WORKTREE_MUTEX.getByName(worktreeId);

    // Plant an already-expired lease, so the test does not wait on the wall clock.
    await runInDurableObject(stub, async (_instance, state) => {
      const expired: WorktreeMutexLease = {
        worktreeId,
        owner: 'crashed-agent',
        token: 'crashed-token',
        expiresAtMs: Date.now() - 1,
      };
      state.storage.kv.put(LEASE_KEY, expired);
    });

    const taken = await stub.acquire(worktreeId, 'agent-b', 60_000);
    expect(taken).not.toBeNull();
    expect(taken?.owner).toBe('agent-b');
    // The crashed holder cannot release the new owner's lock.
    expect(await stub.release('crashed-token')).toBe(false);
  });

  it('expires a live lease on its own after the TTL, without a release', async () => {
    const worktreeId = uniqueId('wt');
    const stub = testEnv.WORKTREE_MUTEX.getByName(worktreeId);

    // The minimum TTL is one second, so this is the shortest real-time expiry the mutex supports.
    expect(await stub.acquire(worktreeId, 'agent-a', 1_000)).not.toBeNull();
    expect(await stub.acquire(worktreeId, 'agent-b', 1_000)).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const afterExpiry = await stub.acquire(worktreeId, 'agent-b', 60_000);
    expect(afterExpiry?.owner).toBe('agent-b');
  });

  it('grants exactly one of many concurrent acquires', async () => {
    const worktreeId = uniqueId('wt');
    const stub = testEnv.WORKTREE_MUTEX.getByName(worktreeId);

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) => stub.acquire(worktreeId, `agent-${index}`, 60_000)),
    );

    expect(results.filter((lease) => lease !== null)).toHaveLength(1);
  });

  it('clears the stored lease when its alarm fires after expiry', async () => {
    const worktreeId = uniqueId('wt');
    const stub = testEnv.WORKTREE_MUTEX.getByName(worktreeId);

    // A scheduled alarm is required for runDurableObjectAlarm to fire, so schedule one alongside the expired lease.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put(LEASE_KEY, {
        worktreeId,
        owner: 'crashed-agent',
        token: 'crashed-token',
        expiresAtMs: Date.now() - 1,
      } satisfies WorktreeMutexLease);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await runDurableObjectAlarm(stub);

    const remaining = await runInDurableObject(stub, (_instance, state) => state.storage.kv.get(LEASE_KEY));
    expect(remaining).toBeUndefined();
  });

  it('clamps an absurd TTL to the one-hour maximum', async () => {
    const worktreeId = uniqueId('wt');
    const stub = testEnv.WORKTREE_MUTEX.getByName(worktreeId);

    const before = Date.now();
    const lease = await stub.acquire(worktreeId, 'agent-a', 10 * 365 * 24 * 60 * 60 * 1000);
    const hourMs = 3_600_000;
    expect(lease).not.toBeNull();
    expect((lease?.expiresAtMs ?? 0) - before).toBeLessThanOrEqual(hourMs + 1_000);
  });
});
