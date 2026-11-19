/** Who is calling. Derived only from a verified API key or session, never from the request body or query. */
export interface Principal {
  readonly orgId: string;
  readonly userId: string;
  readonly role: Role;
  /** How the caller authenticated. Session-only routes check this. */
  readonly via: 'api-key' | 'session';
  /** Set for API-key callers, so the key can be identified in logs and revoked. */
  readonly keyId?: string | undefined;
}

export type Role = 'owner' | 'member';

/**
 * Claims carried inside a dashboard session token. The token is only a pointer: `sid` names a row in `sessions`,
 * and that row decides whether the session is still valid.
 */
export interface SessionClaims {
  /** Session id. Must match an unrevoked, unexpired row in `sessions`. */
  readonly sid: string;
  readonly sub: string;
  readonly org: string;
  readonly role: Role;
  /** Unix seconds. */
  readonly exp: number;
}
