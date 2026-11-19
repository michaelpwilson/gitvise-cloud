/**
 * Deletes session rows that have expired. A session past its expiry is refused whether or not its row exists, so
 * removing it changes nothing a caller can observe. Idempotent, so an overlapping cron run is harmless.
 */
export async function pruneExpiredSessions(db: D1Database, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<number> {
  const result = await db.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(nowSeconds).run();
  return result.meta.changes;
}
