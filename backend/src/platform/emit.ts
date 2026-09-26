/**
 * emitWebhook(boardId, event, data, ctx) — THE import path every command
 * uses (via ports().emitWebhook). Real implementation (platform step):
 *
 *   no active webhook on the board subscribed to `event` → nothing (no task)
 *   else build the Envelope ('evt_…', ISO createdAt, actor name + via) and
 *   enqueue ONE task on `webhooks`, named by the envelope id; the dispatcher
 *   (webhooks.ts) fans it out per webhook.
 *
 * Called after commit; the caller (tickets/effects.ts emitSafe) logs and
 * swallows failures — a webhook must never fail the change that caused it.
 */
import type { EmitWebhookFn } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { buildEnvelope, subscribers } from './webhooks.js';

export const emitWebhook: EmitWebhookFn = async (boardId, event, data, ctx) => {
  const targets = await subscribers(boardId, event);
  if (!targets.length) return;
  const envelope = await buildEnvelope(boardId, event, data, ctx);
  await ports().queue.enqueue('webhooks', { boardId, event, envelope }, { name: envelope.id });
};
