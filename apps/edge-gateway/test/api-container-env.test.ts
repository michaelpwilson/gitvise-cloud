import { describe, expect, it } from 'vitest';
import { apiContainerEnv } from '../src/api-container';
import type { GatewayEnv } from '../src/env';

const base = {
  CLOUDFLARE_GATEWAY_URL: 'https://api.gitvise.com',
  INTERNAL_GATEWAY_SECRET: 'internal-secret',
  WEBAUTHN_RP_ID: 'web.gitvise.com',
  WEBAUTHN_RP_NAME: 'GitStrand',
  WEBAUTHN_ORIGINS: 'https://web.gitvise.com',
} as unknown as GatewayEnv;

describe('apiContainerEnv', () => {
  it('passes the WebAuthn relying party through, so passkeys do not fall back to localhost', () => {
    const env = apiContainerEnv(base);
    expect(env.WEBAUTHN_RP_ID).toBe('web.gitvise.com');
    expect(env.WEBAUTHN_RP_NAME).toBe('GitStrand');
    expect(env.WEBAUTHN_ORIGINS).toBe('https://web.gitvise.com');
  });

  it('keeps every origin on the RP ID host, which apps/api checks at boot', () => {
    const env = apiContainerEnv(base);
    const host = new URL(env.WEBAUTHN_ORIGINS).hostname;
    expect(host === env.WEBAUTHN_RP_ID || host.endsWith(`.${env.WEBAUTHN_RP_ID}`)).toBe(true);
  });

  it('keeps the existing container settings', () => {
    const env = apiContainerEnv(base);
    expect(env.PORT).toBe('3000');
    expect(env.GITVISE_RUNTIME).toBe('cloudflare');
    expect(env.CLOUDFLARE_GATEWAY_URL).toBe('https://api.gitvise.com');
    expect(env.INTERNAL_GATEWAY_SECRET).toBe('internal-secret');
  });

  it('sends blank strings, not undefined, when a WebAuthn var is unset', () => {
    const env = apiContainerEnv({} as GatewayEnv);
    expect(env.WEBAUTHN_RP_ID).toBe('');
    expect(env.WEBAUTHN_ORIGINS).toBe('');
  });
});
