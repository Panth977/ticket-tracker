/**
 * GET /v1/live — THE LIVE CREDENTIAL (docs/plan/agents.html §W, §Z1).
 *
 * An orchestrator that polls costs money for nothing; one that WAKES costs
 * nothing while idle. The wake is a streaming read of the Realtime Database
 * (plain SSE, held by Google's edge and not by a Cloud Run request) on the
 * tiny nodes the command layer bumps:
 *
 *   rev/{boardId}            'something on this board changed'
 *   agents/{agentId}/wake    'something is in your inbox'
 *
 * A token is an API credential, not a Firebase one, so this route mints one:
 * a custom token for the token's PRINCIPAL (the agent id for an agent token,
 * the person's uid otherwise) with the `board` claim backend/database.rules.json
 * reads for a board token, exchanged server-side for an ID token the RTDB
 * REST API accepts as `?auth=`. The rules then say exactly what the SDK's
 * watcher may read: its own wake node (`auth.uid === $agentId`) and its
 * board's rev (`auth.token.board === $boardId`, or the boardReaders mirror
 * for a person). Nothing else in the tree opens up: the Firestore rules go by
 * readerUids, which never carry an agent id, and an `ag_` Auth user has no
 * provider, no password and no email — the only way to hold its ID token is
 * to have been handed one here.
 *
 * SIGNING IN CREATES AN AUTH USER for the uid the first time. The auth
 * triggers (onUserCreated, beforeUserSignedIn) skip `ag_` uids so an agent
 * never gets a users/ profile or an allow-list verdict.
 */
import { errors, isAgentId, live, type RestLiveRes } from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { adminApp, auth, isEmulated } from '../runtime/firebase.js';
import { readableBoards } from './resolve.js';

/**
 * The Identity Toolkit web API key. Public by design (it ships in the SPA):
 * it names the project, it grants nothing. Inlined at deploy from
 * backend/.env.<project> (scripts/deploy-functions.mjs deployDefines); the
 * emulator's Identity Toolkit accepts any value.
 */
export function webApiKey(): string {
  const key = process.env.TM_WEB_API_KEY?.trim();
  if (key) return key;
  if (isEmulated()) return 'demo-web-api-key';
  throw errors.unavailable(
    'Live credentials are not configured on this deployment (TM_WEB_API_KEY)',
  );
}

/** The RTDB origin the SDK streams from: what the Admin SDK itself was given. */
export function databaseUrl(): string {
  const url = process.env.TM_DATABASE_URL?.trim() || adminApp().options.databaseURL;
  if (!url) throw errors.unavailable('This deployment has no Realtime Database configured');
  return url;
}

/** Where a custom token is exchanged: Google's Identity Toolkit, or the Auth emulator's copy of it. */
export function signInUrl(): string {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST?.trim();
  const origin = host ? `http://${host}/` : 'https://';
  return `${origin}identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(webApiKey())}`;
}

/** custom token → { idToken, expiresIn }. */
export async function exchangeCustomToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ idToken: string; expiresIn: number }> {
  const res = await fetchImpl(signInUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, returnSecureToken: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    idToken?: string;
    expiresIn?: string | number;
    error?: { message?: string };
  };
  if (!res.ok || !body.idToken) {
    console.error('[live] signInWithCustomToken failed', res.status, body.error?.message);
    throw errors.unavailable('Could not mint a live credential right now');
  }
  const expiresIn = Number(body.expiresIn ?? 3600);
  return { idToken: body.idToken, expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3600 };
}

/**
 * The credential for this ctx. Paths are exactly the nodes the rules let it
 * read: an agent's wake node plus its board's rev; a person's board token gets
 * its board's rev; an account token gets rev/{b} for every board it reaches
 * right now (resolved at this call, never cached — §R2).
 */
export async function liveCredential(ctx: ServerCtx): Promise<RestLiveRes> {
  const boards = await readableBoards(ctx, { includeArchived: false });
  const boardId = ctx.boardIds?.length === 1 ? ctx.boardIds[0]! : null;
  const agent = isAgentId(ctx.actor);
  // A board token carries its board as a claim (the rules' `auth.token.board`);
  // a person is found through the boardReaders mirror and needs no claim.
  const claims: Record<string, string> = boardId ? { board: boardId } : {};
  const custom = await auth().createCustomToken(ctx.actor, claims);
  const { idToken, expiresIn } = await exchangeCustomToken(custom);
  const paths: string[] = [];
  if (agent) paths.push(live.wake(ctx.actor));
  for (const b of boards) if (!boardId || b.id === boardId) paths.push(live.rev(b.id));
  return { database_url: databaseUrl(), auth: idToken, expires_in: expiresIn, paths };
}
