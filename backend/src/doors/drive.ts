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
import {
  completeDriveConnect,
  driveMode,
  drivePopupConfig,
  drivePopupOrigin,
  DriveRegrant,
  verifyDriveState,
} from '../bucket/drive/link.js';
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

/**
 * GET /integrations/drive/connect?state=… (bucket.html §K1) — the popup flow,
 * served from TM_DRIVE_POPUP_ORIGIN (an origin the Google OAuth client already
 * allows). One button opens Google's consent popup (Google Identity Services
 * code client); the code comes back to this page, which hands it to
 * POST /drive/exchange with the signed state, then returns to the app.
 */
r.get('/drive/connect', async (c) => {
  if (driveMode() !== 'google' || !drivePopupOrigin()) throw errors.not_found('Not found');
  const state = c.req.query('state') ?? '';
  verifyDriveState(state, ports().clock.now());
  const { clientId, scope } = drivePopupConfig();
  const hint = c.req.query('hint') ?? '';
  const cfg = JSON.stringify({ clientId, scope, state, hint }).replace(/</g, '\\u003c');
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Google Drive</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f5f2;color:#1d1d1f;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e3e1dc;border-radius:14px;padding:28px 32px;max-width:420px}
h1{font-size:20px;margin:0 0 8px}p{color:#555;margin:0 0 18px}button{font:inherit;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
button[disabled]{opacity:.6}#msg{margin-top:14px;font-size:14px;color:#b42318}</style></head>
<body><main><h1>Connect Google Drive</h1>
<p>Google asks you to allow access to <b>only the files this app creates or you pick</b> — never the rest of your Drive.</p>
<button id="go">Continue with Google</button><div id="msg" role="alert"></div></main>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script>
const CFG = ${cfg};
const btn = document.getElementById('go'), msg = document.getElementById('msg');
function ask() {
  if (!window.google || !google.accounts) { msg.textContent = 'Google is still loading — try again in a second.'; return; }
  btn.disabled = true; msg.textContent = '';
  google.accounts.oauth2.initCodeClient({
    client_id: CFG.clientId, scope: CFG.scope, ux_mode: 'popup', select_account: true,
    ...(CFG.hint ? { login_hint: CFG.hint } : {}),
    callback: async (r) => {
      if (r.error) { btn.disabled = false; msg.textContent = 'Google said: ' + r.error; return; }
      const res = await fetch('/integrations/drive/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: CFG.state, code: r.code }) });
      const out = await res.json().catch(() => ({}));
      if (out.retry) { btn.disabled = false; btn.textContent = 'Continue once more'; msg.textContent = 'Google needs you to confirm once more.'; return; }
      if (out.redirect) { location.href = out.redirect; return; }
      btn.disabled = false; msg.textContent = out.message || 'Could not connect Google Drive.';
    },
    error_callback: (e) => { btn.disabled = false; msg.textContent = e && e.type === 'popup_closed' ? 'The Google window was closed.' : 'Could not open Google (allow pop-ups for this site).'; },
  }).requestCode();
}
btn.addEventListener('click', ask);
</script></body></html>`);
});

/** POST /integrations/drive/exchange {state, code} — the popup's code → the refresh token. */
r.post('/drive/exchange', async (c) => {
  if (driveMode() !== 'google' || !drivePopupOrigin()) throw errors.not_found('Not found');
  const body = (await c.req.json().catch(() => ({}))) as { state?: string; code?: string };
  const now = ports().clock.now();
  const st = verifyDriveState(body.state, now);
  if (!body.code) throw errors.invalid('Missing code');
  const app = process.env.APP_URL ? appBaseUrl() : '';
  const sep = st.returnTo.includes('?') ? '&' : '?';
  try {
    await completeDriveConnect(st.uid, body.code, now, 'postmessage');
  } catch (e) {
    if (e instanceof DriveRegrant) return c.json({ retry: true });
    const err = toAppError(e);
    return c.json({
      redirect: `${app}${st.returnTo}${sep}drive=error&reason=${encodeURIComponent(err.message)}`,
    });
  }
  return c.json({ redirect: `${app}${st.returnTo}${sep}drive=connected` });
});
