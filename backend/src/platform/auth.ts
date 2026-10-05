/**
 * Token middleware for the platform doors (platform/backend.json middleware):
 *
 *   apiKey  'tm_live_…'  → middleware/apiKey.ts (API key v2: one board, acts as the
 *                          owner or one of their agents) ctx { actor, ownerUid, keyId,
 *                          keyName, via: 'api' | 'mcp', scopes, boardIds: [boardId] }
 *   oauth   any other bearer → oauthTokens/{sha256(token)} kind 'access'
 *                          ctx { actor: row.uid, via: 'mcp' | 'integration', scopes, clientName }
 *
 * A missing / bad token answers 401 with
 *   WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"
 * THAT HEADER IS HOW AN MCP CLIENT DISCOVERS THE WHOLE FLOW (metadata → DCR
 * → PKCE → token). Scopes and boardIds only NARROW what the person's board
 * role allows (can() applies them); they never widen it.
 */
import type { Context, MiddlewareHandler } from 'hono';
import {
  API_KEY_PREFIX,
  errors,
  normalizeScopes,
  paths,
  rateBuckets,
  SCOPES,
  type AppError,
  type OAuthGrant,
  type Scope,
  type Via,
} from '@tm/shared';
import type { AppEnv } from '../http/env.js';
import { problemResponse } from '../http/problem.js';
import { bearer } from '../middleware/user.js';
import { makeCtx, type ServerCtx } from '../runtime/context.js';
import { typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { toAppError } from '../runtime/runner.js';
import { apiKeyCtx } from '../middleware/apiKey.js';
import { sha256hex } from './crypto.js';
import { rateLimit } from './rateLimit.js';
import { ports } from '../adapters/index.js';
import { assertAllowedOwner } from './allow.js';

/** lastUsedAt is refreshed at most once a minute (a write per call would be a hot document). */
export const LAST_USED_EVERY_MS = 60_000;

export { apiKeyCtx };

/** OAuth grants share one budget per grant (MCP agents can be chatty). */
export const OAUTH_LIMITS = { perMin: 120, perDay: 20_000 } as const;

/** The public origin of the API: API_URL when set, else the request's (forwarded) host. */
export function apiBaseUrl(c: Context): string {
  const env = process.env.API_URL;
  if (env) return env.replace(/\/$/, '');
  const url = new URL(c.req.url);
  const proto =
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  const host =
    c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

/** Where the SPA lives (the consent screen). */
export const appBaseUrl = (): string =>
  (process.env.APP_URL ?? 'https://taskmanager.app').replace(/\/$/, '');

export function resourceMetadataUrl(c: Context, resourcePath = ''): string {
  return `${apiBaseUrl(c)}/.well-known/oauth-protected-resource${resourcePath}`;
}

/**
 * 401 that points the client at the protected-resource metadata. `scope` is
 * what an MCP client asks for when it starts the OAuth flow (MCP auth spec:
 * the challenge's scope wins over scopes_supported); the consent screen still
 * lets the person untick any of it. A request with NO token gets no error code
 * (RFC 6750 §3.1) — that is "go and sign in", not "your token is bad".
 */
export function unauthorized(
  c: Context<AppEnv>,
  err: AppError,
  resourcePath = '',
  missing = false,
): Response {
  const rid = c.get('requestId');
  return problemResponse(err, rid ? `urn:request:${rid}` : undefined, {
    'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl(c, resourcePath)}", scope="${SCOPES.join(' ')}"${
      !missing && err.code === 'unauthenticated' ? ', error="invalid_token"' : ''
    }`,
  });
}

/** Stored grant plus the board narrowing chosen on the consent screen (see oauth.ts). */
export type GrantRow = OAuthGrant & { boardIds?: string[] | null };

/** Resolve an OAuth access token into a ctx, or throw 401 / 429. */
export async function oauthCtx(
  token: string,
  via: Extract<Via, 'mcp' | 'integration'>,
  requestId?: string,
): Promise<ServerCtx & { grantId: string; clientId: string }> {
  const now = ports().clock.now();
  const row = (await typedDoc('oauthTokens', paths.oauthToken(sha256hex(token))).get()).data();
  if (!row || row.kind !== 'access' || row.expiresAt <= now)
    throw errors.unauthenticated('Invalid or expired access token');
  // The grant is the revocation switch: grantRevoke deletes it with its tokens.
  const grantRef = db().doc(paths.oauthGrant(row.uid, row.grantId));
  const gs = await grantRef.get();
  if (!gs.exists) throw errors.unauthenticated('This app was disconnected');
  const grant = gs.data() as GrantRow;
  // §X — the person who granted it must still be allowed to use this app.
  await assertAllowedOwner(row.uid);
  await rateLimit(rateBuckets.mcp(row.grantId), OAUTH_LIMITS, now);
  if (now - grant.lastUsedAt > LAST_USED_EVERY_MS) {
    await grantRef.update({ lastUsedAt: now }).catch((e) => console.warn('[oauth] lastUsedAt', e));
  }
  const ctx = makeCtx({
    actor: row.uid,
    via,
    // Stored rows may carry phase-1 scope names; always act on the new vocabulary.
    scopes: normalizeScopes(row.scopes as readonly string[]).scopes,
    boardIds: grant.boardIds ?? null,
    clientName: grant.clientName,
    now,
    ...(requestId ? { requestId } : {}),
  });
  return { ...ctx, grantId: row.grantId, clientId: row.clientId };
}

export interface TokenAuthOptions {
  /** 'mcp' at /mcp; 'integration' for OAuth tokens at /v1. */
  oauthVia: Extract<Via, 'mcp' | 'integration'>;
  /** Accept 'tm_live_' API keys too (phase 2: REST and MCP both do). */
  apiKeys: boolean;
  /** ctx.via for API keys: 'api' at /v1, 'mcp' at /mcp. */
  apiKeyVia?: Extract<Via, 'api' | 'mcp'>;
  /** Suffix for the protected-resource metadata URL, e.g. '/mcp'. */
  resourcePath?: string;
}

/** The apiKey / oauth middleware; sets c.get('ctx'). */
export function tokenAuth(opts: TokenAuthOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (!token)
      return unauthorized(
        c,
        errors.unauthenticated('Missing bearer token'),
        opts.resourcePath,
        true,
      );
    try {
      const ctx =
        opts.apiKeys && token.startsWith(API_KEY_PREFIX)
          ? await apiKeyCtx(token, opts.apiKeyVia ?? 'api', c.get('requestId'))
          : await oauthCtx(token, opts.oauthVia, c.get('requestId'));
      c.set('ctx', ctx);
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'unauthenticated') return unauthorized(c, err, opts.resourcePath);
      throw err;
    }
    await next();
  };
}

/**
 * A route's scope gate (REST_ROUTES / MCP_TOOLS): the credential needs ANY of
 * `scopes`; [] / null = any valid credential. Full sessions (no scopes) pass.
 */
export function requireScope(ctx: ServerCtx, scopes: Scope | readonly Scope[] | null): void {
  const need: readonly Scope[] =
    scopes === null ? [] : typeof scopes === 'string' ? [scopes] : scopes;
  if (!need.length || !ctx.scopes) return;
  if (!need.some((s) => ctx.scopes!.includes(s)))
    throw errors.forbidden(
      need.length === 1
        ? `This token lacks the "${need[0]}" scope`
        : `This token needs one of: ${need.join(', ')}`,
      { scopes: [...need] },
    );
}

/** Every one of `scopes` (e.g. restPatchScopes of a PATCH body). */
export function requireScopes(ctx: ServerCtx, scopes: readonly Scope[]): void {
  for (const s of scopes) requireScope(ctx, s);
}
