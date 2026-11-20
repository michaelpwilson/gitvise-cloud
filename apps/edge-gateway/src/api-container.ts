import { Container } from '@cloudflare/containers';
import type { GatewayEnv } from './env';

/**
 * Port the apps/api container listens on. Its dual-protocol listener serves HTTP/1.1 and h2c on the same port, so
 * every request, including Git smart HTTP, goes to this one port.
 */
export const API_CONTAINER_PORT = 3000;

/**
 * The single apps/api instance. Every request and queue delivery addresses this name, so one container serves
 * them all. The container sleeps after five minutes without traffic, and wakes on the next request or delivery.
 */
export const API_CONTAINER_INSTANCE = 'api';

/** Where the health daemon in the apps/api container serves its metrics. Keep it in step with start-container.sh. */
export const API_CONTAINER_HEALTH_METRICS_URL = 'http://127.0.0.1:9464/metrics';

/**
 * The apps/api container, built from ../gitvise/apps/api/Dockerfile (see `containers` in wrangler.jsonc).
 *
 * Its environment is set here, from the Worker's bindings, so the secrets are never written to wrangler.jsonc:
 *  - `CLOUDFLARE_GATEWAY_URL` (a plain var) is where apps/api calls the gateway's `/internal/*` routes.
 *  - `INTERNAL_GATEWAY_SECRET` (a secret) signs those calls and must match the gateway's own copy.
 */
export class GitViseApiContainer extends Container<GatewayEnv> {
  override defaultPort = API_CONTAINER_PORT;
  override sleepAfter = '5m';

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: GatewayEnv) {
    super(ctx, env);
    this.envVars = {
      PORT: String(API_CONTAINER_PORT),
      GITVISE_RUNTIME: 'cloudflare',
      CLOUDFLARE_GATEWAY_URL: env.CLOUDFLARE_GATEWAY_URL ?? '',
      INTERNAL_GATEWAY_SECRET: env.INTERNAL_GATEWAY_SECRET ?? '',
      // gitvise-healthd runs beside apps/api in this container (start-container.sh), on this port.
      NATIVE_CORE_HEALTH_METRICS_URL: API_CONTAINER_HEALTH_METRICS_URL,
    };
  }
}
