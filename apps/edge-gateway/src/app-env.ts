import type { GatewayEnv } from './env';
import type { Principal } from './auth/types';

/** Hono environment shared by the app and its sub-routers. `principal` is set by the auth middleware. */
export type AppEnv = {
  Bindings: GatewayEnv;
  Variables: { principal: Principal };
};
