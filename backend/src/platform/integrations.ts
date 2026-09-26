/**
 * installConnect (platform/backend.json services.installConnect):
 *
 *   GET|POST /integrations/{provider}/connect   (Firebase ID token; board admin)
 *     → { url }: the provider's install / consent page, carrying a SIGNED
 *       state { uid, boardId, nonce, exp } so the callback cannot be forged
 *   GET /integrations/{provider}/callback?state&code[&installation_id]
 *     → verify state → exchange the code → tokens to the secret store →
 *       boards/{b}/integrations/{provider} written → back to Board settings
 *
 * STUBBED OAUTH. No provider credentials exist in this project, so unless a
 * provider's env vars are set (GITHUB_APP_SLUG; SLACK_CLIENT_ID …) the
 * connect URL points straight at our own callback with a dev code — the
 * whole round trip (state signing, admin check, the integration document)
 * still runs. Provider tokens would live in Secret Manager under
 * integrations/{boardId}/{provider}; the dev fake records them in
 * _dev/secrets instead (never in the integration doc).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  errors,
  IntegrationProviderSchema,
  paths,
  type Integration,
  type IntegrationProvider,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import type { AppEnv } from '../http/env.js';
import { userAuth } from '../middleware/user.js';
import { db, isEmulated } from '../runtime/firebase.js';
import { loadBoard, requireCan } from '../tickets/access.js';
import { apiBaseUrl, appBaseUrl } from './auth.js';
import { base62, safeEqual, serverMac } from './crypto.js';

const STATE_TTL_MS = 10 * 60_000;

interface State {
  uid: string;
  boardId: string;
  provider: IntegrationProvider;
  nonce: string;
  exp: number;
}

export function signState(s: State): string {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${body}.${serverMac('install-state', body)}`;
}

export function verifyState(raw: string | undefined, now: number): State {
  const [body, mac] = (raw ?? '').split('.');
  if (!body || !mac || !safeEqual(mac, serverMac('install-state', body)))
    throw errors.forbidden('Invalid install state');
  const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as State;
  if (s.exp < now)
    throw errors.forbidden('This install link expired — start again from Board settings');
  return s;
}

/** Where the provider sends the person (or, stubbed, our own callback). */
function providerUrl(base: string, provider: IntegrationProvider, state: string): string {
  const cb = `${base}/integrations/${provider}/callback`;
  if (provider === 'github' && process.env.GITHUB_APP_SLUG)
    return `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
  if (provider === 'slack' && process.env.SLACK_CLIENT_ID)
    return `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(process.env.SLACK_CLIENT_ID)}&scope=chat:write,commands&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(cb)}`;
  if (!isEmulated())
    throw errors.unavailable(`The ${provider} integration is not configured on this server`);
  return `${cb}?state=${encodeURIComponent(state)}&code=dev_${base62(12)}${provider === 'github' ? `&installation_id=dev-${base62(8)}` : ''}`;
}

/** The provider's code → tokens + its external id. Stubbed: no network. */
async function exchange(
  provider: IntegrationProvider,
  q: Record<string, string>,
): Promise<{ externalId: string; token: string }> {
  if (!isEmulated())
    throw errors.unavailable(`The ${provider} integration is not configured on this server`);
  if (!q.code) throw errors.invalid('Missing code');
  return {
    externalId: q.installation_id ?? q.team_id ?? `dev-${q.code}`,
    token: `dev-token-${q.code}`,
  };
}

/** Secret store port (Secret Manager in production). */
export const secretStore = {
  async put(boardId: string, provider: string, value: string): Promise<void> {
    if (!isEmulated()) throw errors.unavailable('Secret Manager is not configured');
    await db().doc(`_dev/secrets/items/${boardId}_${provider}`).set({ value, at: Date.now() });
  },
  async delete(boardId: string, provider: string): Promise<void> {
    if (!isEmulated()) return;
    await db().doc(`_dev/secrets/items/${boardId}_${provider}`).delete();
  },
};

const ConnectSchema = z.object({ boardId: z.string().min(1) });

export function registerIntegrationRoutes(r: Hono<AppEnv>): void {
  r.on(['GET', 'POST'], '/:provider/connect', userAuth, async (c) => {
    const provider = IntegrationProviderSchema.safeParse(c.req.param('provider'));
    if (!provider.success) throw errors.not_found('Unknown integration');
    const raw = c.req.method === 'POST' ? await c.req.json().catch(() => ({})) : c.req.query();
    const b = ConnectSchema.safeParse(raw);
    if (!b.success) throw errors.invalid('boardId is required', { field: 'boardId' });
    const ctx = c.get('ctx');
    const board = await loadBoard(ctx, b.data.boardId);
    requireCan(ctx, board, 'admin', null, null, 'Only board admins connect integrations');
    const state = signState({
      uid: ctx.actor,
      boardId: board.id,
      provider: provider.data,
      nonce: base62(12),
      exp: ctx.now + STATE_TTL_MS,
    });
    return c.json({ url: providerUrl(apiBaseUrl(c), provider.data, state) });
  });

  r.get('/:provider/callback', async (c) => {
    const provider = IntegrationProviderSchema.safeParse(c.req.param('provider'));
    if (!provider.success) throw errors.not_found('Unknown integration');
    const q = c.req.query();
    const now = ports().clock.now();
    const st = verifyState(q.state, now);
    if (st.provider !== provider.data) throw errors.forbidden('Invalid install state');
    // Still an admin? The state is 10 minutes old at most, but roles change.
    const board = await loadBoard({ actor: st.uid }, st.boardId);
    requireCan({ actor: st.uid }, board, 'admin');
    const { externalId, token } = await exchange(provider.data, q);
    await secretStore.put(board.id, provider.data, token);

    const ref = db().doc(paths.integration(board.id, provider.data));
    const prev = (await ref.get()).data() as Integration | undefined;
    const config: Integration['config'] = { ...(prev?.config ?? {}) };
    // Dev convenience (the stub has no repo picker): ?repos=org/a,org/b&moveOnMerge=<stageId>
    if (provider.data === 'github' && q.repos) {
      config.repos = q.repos
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((fullName) => ({
          fullName,
          ...(q.moveOnMerge ? { moveOnMerge: q.moveOnMerge } : {}),
        }));
    }
    const doc: Integration = {
      provider: provider.data,
      status: 'active',
      externalId,
      config,
      connectedBy: st.uid,
      connectedAt: now,
    };
    await ref.set(doc);
    return c.redirect(
      `${appBaseUrl()}/b/${board.key}/settings?integration=${provider.data}&connected=1`,
      302,
    );
  });
}
