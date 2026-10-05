/**
 * The OAuth 2.1 DELEGATION layer (platform/backend.json services.oauth).
 * Firebase Auth is the identity; this only lets a person hand an app (an MCP
 * client, an integration) a narrowed, revocable token that acts as them.
 *
 *   code     60s, single use, bound to client + redirect_uri + PKCE S256 challenge
 *   access   1h
 *   refresh  30d, ROTATED on every use. The used one is kept (marked usedAt)
 *            until it expires, so presenting it again is recognised as REUSE —
 *            a stolen token racing the real client — and the WHOLE GRANT is
 *            revoked (theft detection, OAuth 2.1 §4.3.1). Within
 *            REFRESH_RETRY_GRACE_MS of its use it is a retry instead (a
 *            client's parallel or repeated refresh) and gets a fresh pair.
 *
 * Tokens are stored only as sha256 (oauthTokens/{sha256(token)}); the grant
 * (users/{uid}/oauthGrants/{grantId}) is the revocation switch: grantRevoke
 * deletes it and every token under it.
 */
import {
  errors,
  OAUTH_TTL_MS,
  paths,
  normalizeScopes,
  type OAuthClient,
  type OAuthToken,
  type Scope,
} from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { base62, safeEqual, sha256b64url, sha256hex } from './crypto.js';
import { revokeGrantTokens } from './grants.js';

/** RFC 6749 §5.2 error, answered as { error, error_description } (not problem+json). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

/** How long a rotated refresh token may still be presented as a retry rather than as reuse. */
export const REFRESH_RETRY_GRACE_MS = 60_000;

export const TOKEN_PREFIX ={ access: 'tmo_', refresh: 'tmr_', code: 'tmc_' } as const;

/** Stored token row plus server-only bookkeeping. */
export type TokenRow = OAuthToken & { usedAt?: number; createdAt?: number };

const tokenRef = (token: string) => db().doc(paths.oauthToken(sha256hex(token)));

const IGNORED_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

/**
 * The `scope` parameter → the phase-2 vocabulary. Phase-1 names ('boards:read',
 * 'tickets:write', …) from older MCP clients are still accepted and expanded
 * (normalizeScopes); unknown names are invalid_scope.
 */
export function parseScopes(s: string | null | undefined): Scope[] {
  // Generic OAuth/OIDC scopes some clients always add: they ask for nothing here, so they are not an error.
  const want = (s ?? '')
    .split(/[\s,+]+/)
    .filter((x) => x && !IGNORED_SCOPES.has(x));
  const { scopes, unknown } = normalizeScopes(want);
  if (unknown.length) throw new OAuthError('invalid_scope', `Unknown scope: ${unknown.join(', ')}`);
  return scopes;
}

/** OAuth 2.1: https redirect URIs, or loopback http for native apps, or a private-use scheme. */
export function isAllowedRedirectUri(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // Private-use schemes (cursor://, vscode://) — never script-ish ones.
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) &&
    !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol)
  );
}

export async function loadClient(
  clientId: string | null | undefined,
): Promise<OAuthClient & { id: string }> {
  if (!clientId || clientId.includes('/'))
    throw new OAuthError('invalid_client', 'Unknown client', 401);
  const s = await typedDoc('oauthClients', paths.oauthClient(clientId)).get();
  if (!s.exists) throw new OAuthError('invalid_client', 'Unknown client', 401);
  return { ...s.data()!, id: clientId };
}

/** Confidential clients prove themselves at the token endpoint; public ones use PKCE only. */
export function authenticateClient(client: OAuthClient, secret: string | null | undefined): void {
  if (client.public) return;
  if (!secret || !client.secretHash || !safeEqual(sha256hex(secret), client.secretHash))
    throw new OAuthError('invalid_client', 'Client authentication failed', 401);
}

export async function registerClient(
  input: { name: string; redirectUris: string[]; confidential: boolean; logoUrl?: string },
  now: number,
): Promise<{ clientId: string; clientSecret?: string }> {
  const clientId = `tmc_${base62(24)}`;
  const clientSecret = input.confidential ? `tms_${base62(40)}` : undefined;
  const doc: OAuthClient = {
    name: input.name,
    redirectUris: input.redirectUris,
    public: !input.confidential,
    ...(clientSecret ? { secretHash: sha256hex(clientSecret) } : {}),
    registeredVia: 'dcr',
    ...(input.logoUrl ? { logoUrl: input.logoUrl } : {}),
    createdAt: now,
  };
  await typedDoc('oauthClients', paths.oauthClient(clientId)).create(doc);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** Consent approved: upsert the grant and mint a 60-second code. */
export async function approve(opts: {
  uid: string;
  client: OAuthClient & { id: string };
  scopes: Scope[];
  boardIds: string[] | null;
  redirectUri: string;
  codeChallenge: string;
  now: number;
}): Promise<string> {
  // One grant per (person, client): approving again replaces what it may do.
  const grantId = opts.client.id;
  const grantRef = db().doc(paths.oauthGrant(opts.uid, grantId));
  const prev = await grantRef.get();
  // Untyped write: boardIds (the consent screen's board choice) sits beside the contract's OAuthGrant.
  await grantRef.set({
    clientId: opts.client.id,
    clientName: opts.client.name,
    scopes: opts.scopes,
    boardIds: opts.boardIds,
    createdAt: prev.exists ? (prev.get('createdAt') as number) : opts.now,
    lastUsedAt: opts.now,
  });
  const code = TOKEN_PREFIX.code + base62(32);
  const row: TokenRow = {
    kind: 'code',
    uid: opts.uid,
    grantId,
    clientId: opts.client.id,
    scopes: opts.scopes,
    codeChallenge: opts.codeChallenge,
    redirectUri: opts.redirectUri,
    expiresAt: opts.now + OAUTH_TTL_MS.code,
    createdAt: opts.now,
  };
  await tokenRef(code).set(row);
  return code;
}

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function mintPair(
  tx: FirebaseFirestore.Transaction,
  base: Omit<TokenRow, 'kind' | 'expiresAt'>,
  now: number,
): TokenPair {
  const access = TOKEN_PREFIX.access + base62(40);
  const refresh = TOKEN_PREFIX.refresh + base62(48);
  tx.set(tokenRef(access), {
    ...base,
    kind: 'access',
    expiresAt: now + OAUTH_TTL_MS.access,
    createdAt: now,
  });
  tx.set(tokenRef(refresh), {
    ...base,
    kind: 'refresh',
    expiresAt: now + OAUTH_TTL_MS.refresh,
    createdAt: now,
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.round(OAUTH_TTL_MS.access / 1000),
    refresh_token: refresh,
    scope: base.scopes.join(' '),
  };
}

/** grant_type=authorization_code */
export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  redirectUri: string | null;
  verifier: string | null;
  now: number;
}): Promise<TokenPair> {
  if (!opts.verifier || !/^[A-Za-z0-9\-._~]{43,128}$/.test(opts.verifier))
    throw new OAuthError('invalid_request', 'code_verifier is required (PKCE S256)');
  // Any misuse still CONSUMES the code: the transaction commits the delete and
  // hands back the error to throw after it.
  const out = await db().runTransaction(async (tx): Promise<TokenPair | OAuthError> => {
    const ref = tokenRef(opts.code);
    const s = await tx.get(ref);
    const row = s.exists ? (s.data() as TokenRow) : undefined;
    if (!row || row.kind !== 'code')
      return new OAuthError('invalid_grant', 'Unknown or used authorization code');
    const grant = await tx.get(db().doc(paths.oauthGrant(row.uid, row.grantId)));
    tx.delete(ref); // single use, whatever happens next
    if (row.expiresAt <= opts.now)
      return new OAuthError('invalid_grant', 'Authorization code expired');
    if (row.clientId !== opts.clientId)
      return new OAuthError('invalid_grant', 'Code was issued to another client');
    if (row.redirectUri && opts.redirectUri !== row.redirectUri)
      return new OAuthError(
        'invalid_grant',
        'redirect_uri does not match the authorization request',
      );
    if (!row.codeChallenge || !safeEqual(sha256b64url(opts.verifier!), row.codeChallenge))
      return new OAuthError('invalid_grant', 'PKCE verification failed');
    if (!grant.exists) return new OAuthError('invalid_grant', 'The grant was revoked');
    return mintPair(
      tx,
      {
        uid: row.uid,
        grantId: row.grantId,
        clientId: row.clientId,
        scopes: normalizeScopes(row.scopes as readonly string[]).scopes,
      },
      opts.now,
    );
  });
  if (out instanceof OAuthError) throw out;
  return out;
}

/** grant_type=refresh_token — rotation with reuse detection. */
export async function refresh(opts: {
  token: string;
  clientId: string;
  scope: string | null;
  now: number;
}): Promise<TokenPair> {
  let reused: { uid: string; grantId: string } | null = null;
  const pair = await db().runTransaction(async (tx) => {
    reused = null;
    const ref = tokenRef(opts.token);
    const s = await tx.get(ref);
    const row = s.exists ? (s.data() as TokenRow) : undefined;
    if (!row || row.kind !== 'refresh')
      throw new OAuthError('invalid_grant', 'Unknown refresh token');
    if (row.clientId !== opts.clientId)
      throw new OAuthError('invalid_grant', 'Token was issued to another client');
    // A client that refreshes twice at once, or retries after losing the response,
    // presents the same token seconds apart: that is not theft.
    const retry = row.usedAt !== undefined && opts.now - row.usedAt <= REFRESH_RETRY_GRACE_MS;
    if (row.usedAt !== undefined && !retry) {
      // THEFT DETECTION: an already-rotated refresh token came back.
      reused = { uid: row.uid, grantId: row.grantId };
      return null;
    }
    if (row.expiresAt <= opts.now) throw new OAuthError('invalid_grant', 'Refresh token expired');
    const grant = await tx.get(db().doc(paths.oauthGrant(row.uid, row.grantId)));
    if (!grant.exists) throw new OAuthError('invalid_grant', 'The grant was revoked');
    // A refresh may narrow scopes, never widen them.
    const had = normalizeScopes(row.scopes as readonly string[]).scopes; // phase-1 rows carry old names
    const asked = opts.scope ? parseScopes(opts.scope) : had;
    if (asked.some((x) => !had.includes(x)))
      throw new OAuthError('invalid_scope', 'A refresh cannot add scopes');
    if (!retry) tx.update(ref, { usedAt: opts.now });
    return mintPair(
      tx,
      { uid: row.uid, grantId: row.grantId, clientId: row.clientId, scopes: asked },
      opts.now,
    );
  });
  if (pair) return pair;
  const r = reused as { uid: string; grantId: string } | null;
  if (r) {
    await revokeGrantTokens(r.uid, r.grantId);
    await db().doc(paths.oauthGrant(r.uid, r.grantId)).delete();
    console.warn(`[oauth] refresh token reuse: grant ${r.uid}/${r.grantId} revoked`);
  }
  throw new OAuthError(
    'invalid_grant',
    'Refresh token reuse detected — the app must be connected again',
  );
}

/** RFC 7009: revoke a token; unknown tokens are not an error. A refresh token takes its grant's tokens with it. */
export async function revokeToken(token: string, clientId: string | null): Promise<void> {
  const ref = tokenRef(token);
  const s = await ref.get();
  if (!s.exists) return;
  const row = s.data() as TokenRow;
  if (clientId && row.clientId !== clientId) return;
  if (row.kind === 'refresh') await revokeGrantTokens(row.uid, row.grantId);
  else await ref.delete();
}

/** Validate an authorization request (shared by GET /authorize and the consent endpoints). */
export async function checkAuthorizeRequest(p: {
  client_id?: string | null;
  redirect_uri?: string | null;
  response_type?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  scope?: string | null;
}): Promise<{ client: OAuthClient & { id: string }; redirectUri: string; scopes: Scope[] }> {
  let client;
  try {
    client = await loadClient(p.client_id);
  } catch {
    throw errors.invalid('Unknown client_id — the app must register first', { field: 'client_id' });
  }
  const redirectUri =
    p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : '');
  if (!client.redirectUris.includes(redirectUri))
    throw errors.invalid('redirect_uri is not registered for this client', {
      field: 'redirect_uri',
    });
  if (p.response_type !== undefined && p.response_type !== null && p.response_type !== 'code')
    throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
  if (
    !p.code_challenge ||
    (p.code_challenge_method ?? 'S256') !== 'S256' ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)
  )
    throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  const scopes = parseScopes(p.scope);
  return { client, redirectUri, scopes };
}

/** redirect_uri + OAuth params, preserving any query the client registered. */
export function redirectWith(
  uri: string,
  params: Record<string, string | null | undefined>,
): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
