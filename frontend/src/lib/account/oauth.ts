/**
 * /oauth/consent — where GET /oauth/authorize lands (platform/backend.json
 * › oauth). The query carries the authorization request; this page shows who
 * is asking and for what, then hands the decision back to the server, which
 * issues the code and tells us where to send the browser.
 *
 * Endpoints are a local adapter until the contract exists.
 */
import { SCOPE_PRESETS, type Scope } from '@tm/shared';
import { parseScopeParam } from './scopes';
import { postJson } from './rawApi';

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scopes: Scope[];
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  resource: string | null;
}

export type ParsedAuthorize = { ok: true; req: AuthorizeRequest } | { ok: false; error: string };

/** Read and sanity-check the authorization request from the URL. */
export function parseAuthorize(params: URLSearchParams): ParsedAuthorize {
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  if (!clientId) return { ok: false, error: 'The link is missing the app (client_id).' };
  if (!redirectUri)
    return { ok: false, error: 'The link is missing where to return (redirect_uri).' };
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return { ok: false, error: 'The return address is not a valid URL.' };
  }
  // OAuth 2.1: https, or a loopback address for native apps.
  const loopback =
    u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    return { ok: false, error: 'The return address must be https.' };
  }
  const method = params.get('code_challenge_method');
  const challenge = params.get('code_challenge');
  if (!challenge || (method && method !== 'S256')) {
    return { ok: false, error: 'This app did not use a secure sign-in (PKCE S256).' };
  }
  const scopes = parseScopeParam(params.get('scope'));
  return {
    ok: true,
    req: {
      clientId,
      redirectUri,
      // No scope asked = read-only, the least surprising default.
      scopes: scopes.length ? scopes : [...SCOPE_PRESETS.readOnly],
      state: params.get('state'),
      codeChallenge: challenge,
      codeChallengeMethod: method ?? 'S256',
      resource: params.get('resource'),
    },
  };
}

export interface ClientInfo {
  clientName: string;
  logoUrl?: string | null;
}

export function fetchClientInfo(req: AuthorizeRequest): Promise<ClientInfo> {
  return postJson<ClientInfo>('/oauth/consent/info', {
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
  });
}

/** Allow (with the narrowed scopes and board choice) or Cancel → where to send the browser. */
export function decide(
  req: AuthorizeRequest,
  decision: { approve: boolean; scopes: Scope[]; boardIds: string[] | null },
): Promise<{ redirect: string }> {
  return postJson<{ redirect: string }>('/oauth/consent/decide', {
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    scope: decision.scopes.join(' '),
    state: req.state,
    code_challenge: req.codeChallenge,
    code_challenge_method: req.codeChallengeMethod,
    resource: req.resource,
    approve: decision.approve,
    boardIds: decision.boardIds,
  });
}
