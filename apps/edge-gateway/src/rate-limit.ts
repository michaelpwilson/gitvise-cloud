import type { Context } from 'hono';
import type { AppEnv } from './app-env';
import type { Principal } from './auth/types';

/**
 * Rate-limits a request the gateway is about to forward to apps/api. A signed-in caller is counted per user. A signed-out
 * caller is counted per client IP. The check runs in the Worker's own location, so it adds no round trip to the container.
 *
 * Returns a 429 response when the caller is over the limit, and undefined when the request may go on.
 */
export async function limitForwardedRequest(
  c: Context<AppEnv>,
  principal: Principal | undefined,
): Promise<Response | undefined> {
  const limiter = c.env.API_RATE_LIMIT;
  if (limiter === undefined) return undefined;

  const key =
    principal !== undefined
      ? `user:${principal.userId}`
      : `ip:${c.req.header('cf-connecting-ip') ?? 'unknown'}`;
  const { success } = await limiter.limit({ key });
  if (success) return undefined;

  return c.json(
    { error: { code: 'RATE_LIMITED', message: 'too many requests. Wait a minute and try again.' } },
    429,
    { 'retry-after': '60' },
  );
}
