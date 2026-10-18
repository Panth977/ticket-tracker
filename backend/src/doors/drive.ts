/**
 * GET /integrations/drive/callback (bucket.html §K1) — Google sends the person
 * here after the consent page: verify the signed state (whose Drive, where to
 * go back), exchange the code for a refresh token, back to the app.
 *
 * Registered before the board integrations' /:provider routes (doors/ loads
 * before doors/hooks/), so 'drive' never reaches them.
 */
import { errors } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { completeFakeUpload } from '../bucket/drive/api.js';
import { completeDriveConnect, driveMode, verifyDriveState } from '../bucket/drive/link.js';
import { door } from '../http/mounts.js';
import { appBaseUrl } from '../platform/auth.js';
import { toAppError } from '../runtime/runner.js';

const r = door('integrations');

r.get('/drive/callback', async (c) => {
  const q = c.req.query();
  const now = ports().clock.now();
  const st = verifyDriveState(q.state, now);
  const back = (params: string) => {
    const base = process.env.APP_URL ? appBaseUrl() : '';
    const sep = st.returnTo.includes('?') ? '&' : '?';
    return c.redirect(`${base}${st.returnTo}${sep}${params}`, 302);
  };
  if (q.error) return back(`drive=error&reason=${encodeURIComponent(q.error)}`);
  if (!q.code) throw errors.invalid('Missing code');
  try {
    await completeDriveConnect(st.uid, q.code, now);
  } catch (e) {
    const err = toAppError(e);
    return back(`drive=error&reason=${encodeURIComponent(err.message)}`);
  }
  return back('drive=connected');
});

/**
 * PUT /integrations/drive/fake-upload/{token} — the fake Drive's upload session
 * (emulators / TM_DRIVE=fake only): what Google's session URL is for a real
 * Drive. The browser PUTs the whole body here exactly as it would to Google.
 */
r.put('/drive/fake-upload/:token', async (c) => {
  if (driveMode() !== 'fake') throw errors.not_found('Not found');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const f = await completeFakeUpload(c.req.param('token'), bytes);
  return c.json({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.size) });
});
