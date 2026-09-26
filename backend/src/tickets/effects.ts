/**
 * Side effects AFTER a transaction commits: notify(), emitWebhook(), Storage
 * clean-up. They never run inside the transaction (a retried transaction
 * must not notify twice) and they never fail the command: the change is
 * already committed, and failing now would make a clientId retry apply it a
 * second time. A failure is logged; the queues behind notify / emitWebhook
 * retry on their own.
 *
 * Reached through ports() (which carries notify/index.ts and platform/emit.ts)
 * so tests can observe the calls with setPorts({ notify, emitWebhook }).
 */
import type { NotifyEvent, NotifyExtra, TicketWithId, WebhookData, WebhookEvent } from '@tm/shared';
import { ports } from '../adapters/index.js';
import type { ServerCtx } from '../runtime/context.js';

export async function afterCommit(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[tickets] after-commit "${label}" failed`, e);
  }
}

/** notify() that never throws; skips empty explicit recipient lists. */
export function notifySafe(
  event: NotifyEvent,
  ticket: TicketWithId | null,
  ctx: ServerCtx,
  extra?: NotifyExtra,
): Promise<void> {
  if (extra?.mentioned && extra.mentioned.length === 0 && event === 'mentioned')
    return Promise.resolve();
  if (extra?.recipients && extra.recipients.length === 0) return Promise.resolve();
  return afterCommit(`notify:${event}`, () => ports().notify(event, ticket, ctx, extra));
}

/** emitWebhook() that never throws; `build` runs only if emitting (it may read). */
export function emitSafe<E extends WebhookEvent>(
  boardId: string,
  event: E,
  build: () => Promise<WebhookData<E>> | WebhookData<E>,
  ctx: ServerCtx,
): Promise<void> {
  return afterCommit(`webhook:${event}`, async () =>
    ports().emitWebhook(boardId, event, await build(), ctx),
  );
}
