/**
 * /hooks/whatsapp — the Meta Cloud API webhook.
 *
 *   GET  /hooks/whatsapp   subscription handshake: hub.verify_token must equal
 *                          WHATSAPP_VERIFY_TOKEN → echo hub.challenge
 *   POST /hooks/whatsapp   X-Hub-Signature-256 over the raw body with
 *                          WHATSAPP_APP_SECRET → notify/whatsappInbound.ts
 *
 * Without the secret the hook only works under the emulators (dev). A
 * mismatch → 401; the body is never logged. Meta retries non-2xx for days,
 * so everything past the signature answers 200.
 */
import { errors } from '@tm/shared';
import { door } from '../../http/mounts.js';
import { isEmulated } from '../../runtime/firebase.js';
import { verifyMetaSignature } from '../../notify/inbound.js';
import { handleWhatsappWebhook } from '../../notify/whatsappInbound.js';

const hooks = door('hooks');

const verifyToken = () =>
  process.env.WHATSAPP_VERIFY_TOKEN ?? (isEmulated() ? 'dev-verify-token' : undefined);

hooks.get('/whatsapp', (c) => {
  const want = verifyToken();
  if (c.req.query('hub.mode') === 'subscribe' && want && c.req.query('hub.verify_token') === want) {
    return c.text(c.req.query('hub.challenge') ?? '', 200);
  }
  throw errors.forbidden('Verification failed');
});

hooks.post('/whatsapp', async (c) => {
  const raw = await c.req.text();
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) {
    if (!verifyMetaSignature(c.req.header('x-hub-signature-256'), raw, secret)) {
      throw errors.unauthenticated('Bad webhook signature');
    }
  } else if (!isEmulated()) {
    throw errors.unauthenticated('WhatsApp is not configured');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw errors.invalid('Body is not valid JSON');
  }
  const outcomes = await handleWhatsappWebhook(payload);
  return c.json({ ok: true, outcomes });
});
