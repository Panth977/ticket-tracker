/**
 * webhookUpsert (platform/backend.json services.webhookUpsert) — Board
 * settings › Webhooks and POST/PATCH /v1/webhooks.
 *
 *   can(admin) on the board (a token also needs webhooks:manage)
 *   https only; the host is resolved and private / link-local ranges refused
 *   create → a secret, shown ONCE (only its sha256 is stored)
 *   rotateSecret → a new secret, shown once; the old one stops signing at once
 *   then a 'ping' is sent; the webhook is saved even if it fails, but says so
 */
import { errors, paths, type Webhook } from '@tm/shared';
import { base62, sha256hex } from '../platform/crypto.js';
import { assertPublicHttpsUrl } from '../platform/net.js';
import {
  buildEnvelope,
  deliverAttempt,
  webhookSecret,
  type WebhookRow,
} from '../platform/webhooks.js';
import { db } from '../runtime/firebase.js';
import { loadBoard, requireCan } from '../tickets/access.js';
import { defineCommand } from './_registry.js';

export default defineCommand('webhookUpsert', async (ctx, input) => {
  const board = await loadBoard(ctx, input.boardId);
  requireCan(ctx, board, 'admin', null, null, 'Only board admins manage webhooks');
  const url = (await assertPublicHttpsUrl(input.url)).toString();
  const events = [...new Set(input.events)];

  const webhookId = input.webhookId ?? ctx.ids.id();
  const ref = db().doc(paths.webhook(board.id, webhookId));
  let secret: string | undefined;

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? (snap.data() as WebhookRow) : undefined;
    if (input.webhookId && !cur) throw errors.not_found('Webhook not found');
    const rotate = !cur || input.rotateSecret === true;
    const nonce = rotate ? base62(16) : (cur!.secretNonce ?? '');
    if (rotate) secret = webhookSecret(board.id, webhookId, nonce);
    // Untyped write: secretNonce is a server-only field beside the contract's Webhook.
    const row: WebhookRow = {
      url,
      events,
      active: input.active ?? cur?.active ?? true,
      // Re-enabling (or changing the URL) starts the failure count over.
      failures: cur && cur.url === url && !(input.active && !cur.active) ? cur.failures : 0,
      secretHash: rotate ? sha256hex(secret!) : cur!.secretHash,
      secretNonce: nonce,
      createdBy: cur?.createdBy ?? ctx.actor,
      createdAt: cur?.createdAt ?? ctx.now,
    } satisfies Webhook & { secretNonce: string };
    tx.set(ref, row);
  });

  const envelope = await buildEnvelope(board.id, 'ping', { webhook_id: webhookId }, ctx);
  const r = await deliverAttempt(board.id, webhookId, envelope);
  return {
    webhookId,
    ...(secret ? { secret } : {}),
    ping: { ok: r.ok, status: r.status },
  };
});
