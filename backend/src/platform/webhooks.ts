/**
 * Outgoing webhooks (platform/backend.json services.webhookDispatch):
 *
 *   emitWebhook(boardId, event, data, ctx)      (emit.ts — every command, after commit)
 *     → one envelope 'evt_…' on the `webhooks` queue, named by its id (dedupe)
 *   dispatch task, no webhookId                 FAN OUT
 *     → one task per active webhook whose events match, named `${evt}-${webhookId}`
 *   dispatch task, with webhookId               DELIVER one attempt
 *     POST JSON, X-TM-Event / X-TM-Delivery / X-TM-Signature, 10s timeout,
 *     redirects not followed, SSRF re-checked (DNS can change after save)
 *     2xx  → row 'ok', webhook.failures = 0
 *     else → row 'failed' and a follow-up task after 1m, 5m, 30m, 2h, 6h, 12h;
 *            after the last one → 'gave_up', failures++
 *     failures ≥ 20 → active = false, the webhook's creator is emailed
 *
 * WHY RETRIES ARE OUR OWN TASKS, not Cloud Tasks' retry: the schedule is
 * exact and the attempt count is visible (each attempt is a delivery row —
 * the attempt number is the number of rows so far), and the handler only
 * throws for OUR failures (Firestore down), which Cloud Tasks then retries.
 *
 * SIGNING SECRETS ARE DERIVED, NOT STORED: secret = HMAC(server key,
 * board/webhook/nonce). The document keeps only sha256(secret) (shown once,
 * like every credential here) and the nonce; rotateSecret changes the nonce.
 */
import {
  errors,
  formatSignatureHeader,
  paths,
  signaturePayload,
  toIso,
  WEBHOOK_HEADERS,
  WEBHOOK_MAX_FAILURES,
  type CommandCtx,
  type Envelope,
  type User,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookTask,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { db } from '../runtime/firebase.js';
import { defineTask } from '../runtime/functions.js';
import { actorName } from '../tickets/writes.js';
import { hmacHex, serverMac } from './crypto.js';
import { assertPublicHttpsUrl, net } from './net.js';

const MIN = 60_000;
/** Delay before attempt 2, 3, … (platform/backend.json: 1m, 5m, 30m, 2h, 6h, 12h). */
export const RETRY_DELAYS_MS = [
  1 * MIN,
  5 * MIN,
  30 * MIN,
  120 * MIN,
  360 * MIN,
  720 * MIN,
] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const DELIVERY_TIMEOUT_MS = 10_000;
const SNIPPET_BYTES = 500;

/** The stored webhook plus the (server-only) secret nonce. */
export type WebhookRow = Webhook & { secretNonce?: string };

export const webhookSecret = (boardId: string, webhookId: string, nonce: string): string =>
  `whsec_${serverMac('webhook-secret', `${boardId}/${webhookId}/${nonce}`)}`;

// ─── envelopes ───────────────────────────────────────────────────────────────

export async function buildEnvelope(
  boardId: string,
  type: Envelope['type'],
  data: unknown,
  ctx: Pick<CommandCtx, 'actor' | 'via' | 'now'>,
): Promise<Envelope> {
  return {
    id: `evt_${ports().ids.id()}`,
    type,
    createdAt: toIso(ctx.now)!,
    boardId,
    actor: { id: ctx.actor, name: await actorName(ctx, boardId), via: ctx.via },
    data,
  };
}

// ─── one attempt ─────────────────────────────────────────────────────────────

export interface AttemptResult {
  ok: boolean;
  status: number | null;
  snippet: string;
  durationMs: number;
}

/** POST one signed envelope. Never throws: every outcome is a result. */
export async function postEnvelope(
  url: string,
  secret: string,
  envelope: Envelope,
  deliveryId: string,
  now: number,
): Promise<AttemptResult> {
  const started = Date.now();
  const body = JSON.stringify(envelope);
  const t = Math.floor(now / 1000);
  try {
    await assertPublicHttpsUrl(url);
    const res = await net().fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'TaskManager-Webhooks/1',
        [WEBHOOK_HEADERS.event]: envelope.type,
        [WEBHOOK_HEADERS.delivery]: deliveryId,
        [WEBHOOK_HEADERS.signature]: formatSignatureHeader(
          t,
          hmacHex(secret, signaturePayload(t, body)),
        ),
      },
      body,
    });
    let text = '';
    try {
      text = (await res.text()).slice(0, 2000);
    } catch {
      /* body unreadable: keep the status */
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      snippet: Buffer.from(text).subarray(0, SNIPPET_BYTES).toString('utf8').replace(/�+$/, ''),
      durationMs: Date.now() - started,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: null,
      snippet: msg.slice(0, SNIPPET_BYTES),
      durationMs: Date.now() - started,
    };
  }
}

const webhookDoc = (boardId: string, webhookId: string) =>
  db().doc(paths.webhook(boardId, webhookId));

/**
 * Deliver one attempt of `envelope` to one webhook, log it, and schedule
 * the next attempt or give up. Returns the attempt's outcome.
 */
export async function deliverAttempt(
  boardId: string,
  webhookId: string,
  envelope: Envelope,
): Promise<AttemptResult & { attempt: number; skipped?: true }> {
  const ref = webhookDoc(boardId, webhookId);
  const snap = await ref.get();
  if (!snap.exists)
    return { ok: false, status: null, snippet: '', durationMs: 0, attempt: 0, skipped: true };
  const hook = snap.data() as WebhookRow;
  // A disabled webhook still gets its ping (so an admin can test a fix), nothing else.
  if (!hook.active && envelope.type !== 'ping')
    return { ok: false, status: null, snippet: '', durationMs: 0, attempt: 0, skipped: true };

  const deliveries = db().collection(paths.webhookDeliveries(boardId, webhookId));
  const prior = await deliveries.where('envelopeId', '==', envelope.id).count().get();
  const attempt = prior.data().count + 1;
  const now = ports().clock.now();
  const deliveryId = `${envelope.id}-${attempt}`;

  const secret = webhookSecret(boardId, webhookId, hook.secretNonce ?? '');
  const r = await postEnvelope(hook.url, secret, envelope, deliveryId, now);

  const isPing = envelope.type === 'ping';
  const last = isPing || attempt >= MAX_ATTEMPTS;
  const status: WebhookDelivery['status'] = r.ok
    ? 'ok'
    : last
      ? isPing
        ? 'failed'
        : 'gave_up'
      : 'failed';
  const nextAttemptAt = !r.ok && !last ? now + RETRY_DELAYS_MS[attempt - 1]! : null;
  const row: WebhookDelivery = {
    event: envelope.type,
    envelopeId: envelope.id,
    attempt,
    status,
    responseCode: r.status,
    responseSnippet: r.snippet,
    durationMs: r.durationMs,
    nextAttemptAt,
    createdAt: now,
  };
  await deliveries.doc(deliveryId).set(row);

  if (r.ok) {
    if (hook.failures !== 0) await ref.update({ failures: 0 });
  } else if (nextAttemptAt !== null) {
    await ports().queue.enqueue(
      'webhooks',
      { boardId, event: envelope.type, envelope, webhookId },
      {
        name: `${envelope.id}-${webhookId}-a${attempt + 1}`,
        delaySeconds: Math.round((nextAttemptAt - now) / 1000),
      },
    );
  } else if (status === 'gave_up') {
    await recordGaveUp(boardId, webhookId, hook);
  }
  return { ...r, attempt };
}

/** failures++; at the limit, switch the webhook off and tell whoever set it up. */
async function recordGaveUp(boardId: string, webhookId: string, hook: WebhookRow): Promise<void> {
  const ref = webhookDoc(boardId, webhookId);
  const disabled = await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return false;
    const h = s.data() as WebhookRow;
    const failures = h.failures + 1;
    const off = failures >= WEBHOOK_MAX_FAILURES && h.active;
    tx.update(ref, { failures, ...(off ? { active: false } : {}) });
    return off;
  });
  if (!disabled) return;
  try {
    const u = (await db().doc(paths.user(hook.createdBy)).get()).data() as User | undefined;
    const m = (await db().doc(paths.member(boardId, hook.createdBy)).get()).data() as
      { email?: string } | undefined;
    const to = u?.email || m?.email;
    const board = (await db().doc(paths.board(boardId)).get()).data() as
      { name?: string } | undefined;
    if (to) {
      await ports().email.send({
        to,
        subject: `Webhook disabled on ${board?.name ?? 'your board'}`,
        text:
          `The webhook to ${hook.url} failed ${WEBHOOK_MAX_FAILURES} deliveries in a row, so it was switched off.\n\n` +
          `Fix the receiver, then turn it back on in Board settings › Webhooks. Recent deliveries show each response.`,
        tag: 'webhook-disabled',
      });
    }
  } catch (e) {
    console.error('[webhooks] could not email the owner', e);
  }
}

// ─── fan-out ─────────────────────────────────────────────────────────────────

/** Active webhooks on a board subscribed to `event`. */
export async function subscribers(boardId: string, event: WebhookEvent): Promise<string[]> {
  const snap = await db().collection(paths.webhooks(boardId)).where('active', '==', true).get();
  return snap.docs
    .filter((d) => ((d.data() as Webhook).events ?? []).includes(event))
    .map((d) => d.id);
}

export async function dispatch(task: WebhookTask): Promise<void> {
  if (task.webhookId) {
    await deliverAttempt(task.boardId, task.webhookId, task.envelope);
    return;
  }
  if (task.event === 'ping') return; // a ping always names its webhook
  const ids = await subscribers(task.boardId, task.event);
  await Promise.all(
    ids.map((webhookId) =>
      ports().queue.enqueue(
        'webhooks',
        { ...task, webhookId },
        { name: `${task.envelope.id}-${webhookId}` },
      ),
    ),
  );
}

defineTask('webhooks', (data) => dispatch(data));

/** Webhook row → the REST shape. */
export function toRestWebhook(boardKey: string, id: string, w: Webhook) {
  return {
    id,
    board: boardKey,
    url: w.url,
    events: w.events,
    active: w.active,
    failures: w.failures,
    created_at: toIso(w.createdAt)!,
  };
}

/** A fresh-looking 404 for webhooks the caller cannot manage. */
export const webhookNotFound = () => errors.not_found('Webhook not found');
