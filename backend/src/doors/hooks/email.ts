/**
 * /hooks/email — inbound mail (Resend inbound → Svix-signed webhook) and the
 * one-click List-Unsubscribe endpoint every notification mail carries.
 *
 *   POST /hooks/email                 signed → notify/emailInbound.ts
 *   POST /hooks/email/unsubscribe?t=  RFC 8058 one-click: 'email' off for that event
 *   GET  /hooks/email/unsubscribe?t=  → the settings page (a GET never changes
 *                                       anything: link scanners follow GETs)
 *
 * Signature: RESEND_WEBHOOK_SECRET ('whsec_…'). Without it the hook only
 * works under the emulators (dev); in production it answers 401.
 * A mismatch → 401 and the body is never logged.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { errors, paths } from '@tm/shared';
import { ports } from '../../adapters/index.js';
import { door } from '../../http/mounts.js';
import { db, isEmulated } from '../../runtime/firebase.js';
import { handleInboundEmail, parseInbound } from '../../notify/emailInbound.js';
import { settingsUrl } from '../../notify/deliver.js';
import { verifySvix } from '../../notify/inbound.js';
import { verifyUnsubscribeToken } from '../../notify/tokens.js';

const hooks = door('hooks');

/** 25 MB: mail with attachments, base64-encoded. */
const MAX_INBOUND_BODY = 25 * 1024 * 1024;

hooks.post('/email', async (c) => {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > MAX_INBOUND_BODY) throw errors.too_large('Inbound mail over 25 MB');
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const ok = verifySvix(
      {
        id: c.req.header('svix-id'),
        timestamp: c.req.header('svix-timestamp'),
        signature: c.req.header('svix-signature'),
      },
      raw,
      secret,
      ports().clock.now(),
    );
    if (!ok) throw errors.unauthenticated('Bad webhook signature');
  } else if (!isEmulated()) {
    throw errors.unauthenticated('Inbound mail is not configured');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw errors.invalid('Body is not valid JSON');
  }
  const type = (payload as { type?: unknown }).type;
  if (typeof type === 'string' && type !== 'email.received')
    return c.json({ ok: true, ignored: type });
  const mail = parseInbound(payload);
  if (!mail) return c.json({ ok: true, outcome: { kind: 'dropped', reason: 'not a mail' } });
  const outcome = await handleInboundEmail(mail);
  return c.json({ ok: true, outcome });
});

hooks.get('/email/unsubscribe', (c) => c.redirect(settingsUrl(), 302));

hooks.post('/email/unsubscribe', async (c) => {
  const parsed = verifyUnsubscribeToken(c.req.query('t') ?? '');
  if (!parsed) throw errors.invalid('Bad unsubscribe link');
  const ref = db().doc(paths.user(parsed.uid));
  const snap = await ref.get();
  if (snap.exists)
    await ref.update(`notify.channels.${parsed.event}`, FieldValue.arrayRemove('email'));
  return c.json({ ok: true });
});
