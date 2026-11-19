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

/** Claims carried inside a dashboard session token. */
export interface SessionClaims {
  readonly sub: string;
  readonly org: string;
  readonly role: Role;
  /** Unix seconds. */
  readonly exp: number;
}

/** What the key cache stores. The raw key is never cached, only the identity it resolves to. */
export interface CachedKey {
  readonly orgId: string;
  readonly userId: string;
  readonly role: Role;
  readonly keyId: string;
}
