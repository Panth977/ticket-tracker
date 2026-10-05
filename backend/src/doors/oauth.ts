/**
 * OAuth 2.1 authorization server + discovery (platform/backend.json services.oauth):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server       RFC 8414
 *   POST /oauth/register     RFC 7591 dynamic client registration
 *   GET  /oauth/authorize    → the consent screen (Svelte route /oauth/consent)
 *   POST /oauth/consent/info    { client_id, redirect_uri } → { clientName, logoUrl }   (Firebase ID token)
 *   POST /oauth/consent/decide  { …request, approve, boardIds } → { redirect }       (Firebase ID token)
 *   POST /oauth/token        authorization_code + PKCE S256 | refresh_token
 *   POST /oauth/revoke       RFC 7009
 *
 * THE FLOW AN MCP CLIENT RUNS, with nobody pasting a key anywhere: its first
 * call to /mcp gets 401 + WWW-Authenticate naming the protected-resource
 * metadata → it reads the authorization server metadata → registers itself
 * (DCR) → opens /oauth/authorize with PKCE → the person approves on our
 * consent screen → the client swaps the code for tokens.
 *
 * The protocol endpoints answer RFC 6749 errors ({ error, error_description });
 * the consent endpoints, called by our own SPA, answer problem+json like /api.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { errors, rateBuckets, SCOPES, type Scope } from '@tm/shared';
import { ports } from '../adapters/index.js';
import type { AppEnv } from '../http/env.js';
import { door } from '../http/mounts.js';
import { userAuth } from '../middleware/user.js';
import { apiBaseUrl, appBaseUrl } from '../platform/auth.js';
import { sha256hex } from '../platform/crypto.js';
import {
  approve,
  authenticateClient,
  checkAuthorizeRequest,
  exchangeCode,
  isAllowedRedirectUri,
  loadClient,
  OAuthError,
  parseScopes,
  redirectWith,
  refresh,
  registerClient,
  revokeToken,
} from '../platform/oauth.js';
import { rateLimit } from '../platform/rateLimit.js';
import { readableBoards } from '../platform/resolve.js';
import { invalidFromZod } from '../runtime/runner.js';

type C = Context<AppEnv>;

/** Browser-based clients (MCP inspectors, web apps) call discovery, DCR and token cross-origin. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '600',
};

function oauthError(c: C, e: OAuthError): Response {
  return c.json({ error: e.error, error_description: e.description }, e.status as 400, {
    ...CORS,
    'cache-control': 'no-store',
    ...(e.status === 401 ? { 'www-authenticate': 'Basic realm="oauth"' } : {}),
  });
}

async function protocol(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(c, e);
    throw e;
  }
}

/** Form-encoded (the standard) or JSON body, as a flat string map. */
async function params(c: C): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  const text = await c.req.text();
  if (text.length > 64 * 1024) throw new OAuthError('invalid_request', 'Body too large');
  if (type.includes('application/json')) {
    try {
      const j = JSON.parse(text || '{}') as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(j).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      );
    } catch {
      throw new OAuthError('invalid_request', 'Body is not valid JSON');
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** client_secret_basic or client_secret_post → { clientId, secret }. */
function clientCredentials(
  c: C,
  p: Record<string, string>,
): { clientId: string | null; secret: string | null } {
  const basic = /^Basic\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
  if (basic) {
    const [id, secret] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
    return { clientId: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
  }
  return { clientId: p.client_id ?? null, secret: p.client_secret ?? null };
}

const clientIp = (c: C) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';

// ─── discovery ───────────────────────────────────────────────────────────────

const wk = door('wellKnown');
wk.options('*', (c) => c.body(null, 204, CORS));

function resourceMetadata(c: C, resource: string) {
  const base = apiBaseUrl(c);
  return c.json(
    {
      resource,
      authorization_servers: [base],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'TaskManager',
      resource_documentation: `${base}/v1/openapi.json`,
    },
    200,
    CORS,
  );
}
wk.get('/oauth-protected-resource', (c) => resourceMetadata(c, `${apiBaseUrl(c)}/mcp`));
wk.get('/oauth-protected-resource/mcp', (c) => resourceMetadata(c, `${apiBaseUrl(c)}/mcp`));
wk.get('/oauth-protected-resource/v1', (c) => resourceMetadata(c, `${apiBaseUrl(c)}/v1`));

function authServerMetadata(c: C) {
  const base = apiBaseUrl(c);
  return c.json(
    {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      scopes_supported: [...SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
        'client_secret_basic',
      ],
      service_documentation: `${base}/v1/openapi.json`,
    },
    200,
    CORS,
  );
}
wk.get('/oauth-authorization-server', authServerMetadata);
wk.get('/oauth-authorization-server/*', authServerMetadata);
// Some clients probe OIDC discovery first; the same document answers.
wk.get('/openid-configuration', authServerMetadata);

// ─── registration ────────────────────────────────────────────────────────────

const oauth = door('oauth');
oauth.options('*', (c) => c.body(null, 204, CORS));

const RegisterSchema = z
  .object({
    client_name: z.string().trim().min(1).max(120).optional(),
    redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
    token_endpoint_auth_method: z
      .enum(['none', 'client_secret_post', 'client_secret_basic'])
      .optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    logo_uri: z.string().url().startsWith('https://').optional(),
    scope: z.string().optional(),
  })
  .passthrough();

oauth.post('/register', (c) =>
  protocol(c, async () => {
    const now = ports().clock.now();
    try {
      await rateLimit(
        rateBuckets.ip(sha256hex(`dcr:${clientIp(c)}`)),
        { perMin: 20, perDay: 500 },
        now,
      );
    } catch {
      throw new OAuthError('slow_down', 'Too many registrations from this address', 429);
    }
    let raw: unknown;
    try {
      raw = JSON.parse((await c.req.text()) || '{}');
    } catch {
      throw new OAuthError('invalid_client_metadata', 'Body is not valid JSON');
    }
    const r = RegisterSchema.safeParse(raw);
    if (!r.success)
      throw new OAuthError(
        'invalid_client_metadata',
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    const m = r.data;
    const bad = m.redirect_uris.filter((u) => !isAllowedRedirectUri(u));
    if (bad.length)
      throw new OAuthError(
        'invalid_redirect_uri',
        `Not an allowed redirect URI: ${bad.join(', ')}`,
      );
    if (m.grant_types?.some((g) => !['authorization_code', 'refresh_token'].includes(g)))
      throw new OAuthError(
        'invalid_client_metadata',
        'Only authorization_code and refresh_token grants are supported',
      );
    const method = m.token_endpoint_auth_method ?? 'none';
    const name = m.client_name ?? new URL(m.redirect_uris[0]!).host ?? 'Unnamed app';
    const { clientId, clientSecret } = await registerClient(
      {
        name,
        redirectUris: m.redirect_uris,
        confidential: method !== 'none',
        ...(m.logo_uri ? { logoUrl: m.logo_uri } : {}),
      },
      now,
    );
    return c.json(
      {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(now / 1000),
        client_name: name,
        redirect_uris: m.redirect_uris,
        token_endpoint_auth_method: method,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(m.logo_uri ? { logo_uri: m.logo_uri } : {}),
      },
      201,
      { ...CORS, 'cache-control': 'no-store' },
    );
  }),
);

// ─── authorize → consent ─────────────────────────────────────────────────────

/**
 * Validate, then hand the browser to the SPA's consent screen with the same
 * query. A bad client or redirect_uri is shown as an error (never redirected
 * to — that would make us an open redirector); anything else goes back to
 * the client as ?error=… per RFC 6749 §4.1.2.1.
 */
oauth.get('/authorize', async (c) => {
  const q = c.req.query();
  try {
    await checkAuthorizeRequest(q);
  } catch (e) {
    if (e instanceof OAuthError && q.redirect_uri) {
      const client = await loadClient(q.client_id).catch(() => null);
      if (client?.redirectUris.includes(q.redirect_uri))
        return c.redirect(
          redirectWith(q.redirect_uri, {
            error: e.error,
            error_description: e.description,
            state: q.state,
            iss: apiBaseUrl(c),
          }),
          302,
        );
    }
    throw e instanceof OAuthError ? errors.invalid(e.description) : e;
  }
  const target = new URL(`${appBaseUrl()}/oauth/consent`);
  for (const [k, v] of Object.entries(q)) target.searchParams.set(k, v);
  return c.redirect(target.toString(), 302);
});

const ConsentInfoSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
});

oauth.post('/consent/info', userAuth, async (c) => {
  const b = ConsentInfoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) throw invalidFromZod(b.error);
  const { client } = await checkAuthorizeRequest({
    client_id: b.data.client_id,
    redirect_uri: b.data.redirect_uri,
    code_challenge: 'x'.repeat(43), // only the client + redirect are being asked about here
  }).catch((e) => {
    throw e instanceof OAuthError ? errors.invalid(e.description) : e;
  });
  return c.json({ clientName: client.name, logoUrl: client.logoUrl ?? null });
});

const DecideSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  scope: z.string().optional().default(''),
  state: z.string().nullable().optional(),
  code_challenge: z.string().nullable().optional(),
  code_challenge_method: z.string().nullable().optional(),
  resource: z.string().nullable().optional(),
  approve: z.boolean(),
  boardIds: z.array(z.string().min(1)).nullable().optional(),
});

oauth.post('/consent/decide', userAuth, async (c) => {
  const b = DecideSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) throw invalidFromZod(b.error);
  const d = b.data;
  const ctx = c.get('ctx');
  let checked;
  try {
    checked = await checkAuthorizeRequest(d);
  } catch (e) {
    throw e instanceof OAuthError ? errors.invalid(e.description) : e;
  }
  const iss = apiBaseUrl(c);
  if (!d.approve)
    return c.json({
      redirect: redirectWith(checked.redirectUri, { error: 'access_denied', state: d.state, iss }),
    });

  // No scope asked = everything the consent screen offers (it matches; the person unticks there).
  const scopes: Scope[] = checked.scopes.length ? checked.scopes : [...SCOPES];
  let boardIds: string[] | null = null;
  if (d.boardIds) {
    const mine = new Set(
      (
        await readableBoards(
          { ...ctx, scopes: undefined, boardIds: null },
          { includeArchived: true },
        )
      ).map((x) => x.id),
    );
    const bad = d.boardIds.filter((x) => !mine.has(x));
    if (bad.length) throw errors.invalid('You are not on some of these boards', { boardIds: bad });
    boardIds = [...new Set(d.boardIds)];
  }
  const code = await approve({
    uid: ctx.actor,
    client: checked.client,
    scopes,
    boardIds,
    redirectUri: checked.redirectUri,
    codeChallenge: d.code_challenge!,
    now: ctx.now,
  });
  return c.json({ redirect: redirectWith(checked.redirectUri, { code, state: d.state, iss }) });
});

// ─── token, revoke ───────────────────────────────────────────────────────────

oauth.post('/token', (c) =>
  protocol(c, async () => {
    const p = await params(c);
    const { clientId, secret } = clientCredentials(c, p);
    const client = await loadClient(clientId);
    authenticateClient(client, secret);
    const now = ports().clock.now();
    let pair;
    if (p.grant_type === 'authorization_code') {
      if (!p.code) throw new OAuthError('invalid_request', 'code is required');
      pair = await exchangeCode({
        code: p.code,
        clientId: client.id,
        redirectUri: p.redirect_uri ?? null,
        verifier: p.code_verifier ?? null,
        now,
      });
    } else if (p.grant_type === 'refresh_token') {
      if (!p.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required');
      if (p.scope) parseScopes(p.scope);
      pair = await refresh({
        token: p.refresh_token,
        clientId: client.id,
        scope: p.scope ?? null,
        now,
      });
    } else {
      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    }
    return c.json(pair, 200, { ...CORS, 'cache-control': 'no-store', pragma: 'no-cache' });
  }),
);

oauth.post('/revoke', (c) =>
  protocol(c, async () => {
    const p = await params(c);
    if (!p.token) throw new OAuthError('invalid_request', 'token is required');
    const { clientId, secret } = clientCredentials(c, p);
    if (clientId) authenticateClient(await loadClient(clientId), secret);
    await revokeToken(p.token, clientId);
    return c.body(null, 200, CORS);
  }),
);
