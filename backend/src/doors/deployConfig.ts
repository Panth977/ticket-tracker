/**
 * GET /config.json on the IceBase server (TM_ICEBASE=emulator) — what the browser needs to know
 * about this deploy, as the VM server answers it (server.ts): the Web Push key, the admin, where
 * artifacts are served. Elsewhere: 404 (Firebase has no such file; the VM server answers itself).
 */
import { door } from '../http/mounts.js';
import { ensureVapid } from '../adapters/webPush.js';
import { artifactOrigin } from '../artifacts/capability.js';
import { onIcebaseServer } from '../runtime/platform.js';

const r = door('deployConfig');

r.get('/', async (c) => {
  if (!onIcebaseServer()) return c.text('Not found\n', 404);
  const { publicKey } = await ensureVapid();
  c.header('cache-control', 'no-cache');
  return c.json({ platform: 'icebase', vapidKey: publicKey, adminEmail: process.env.TM_ADMIN_EMAIL ?? null, artifactOrigin: artifactOrigin() });
});
