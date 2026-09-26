/**
 * The dev outbox: fakes record what they would have sent as Firestore docs so
 * a developer (emulator UI) and tests can see them.
 *
 *   _dev/mail/items/{id}       every e-mail
 *   _dev/push/items/{id}       every push, one doc per send() call
 *   _dev/whatsapp/items/{id}   every WhatsApp template / text
 *   (the queue's dev mode keeps tasks in memory — see queue.ts)
 *
 * Items carry `at` (millis) for ordering. Server-only: rules deny `_dev`.
 */
import { db } from '../runtime/firebase.js';

export const DEV_OUTBOX = {
  mail: '_dev/mail/items',
  push: '_dev/push/items',
  whatsapp: '_dev/whatsapp/items',
} as const;
export type DevOutbox = keyof typeof DEV_OUTBOX;

/** Record one item; returns its doc id (used as the fake providerId). */
export async function recordDev(box: DevOutbox, data: Record<string, unknown>): Promise<string> {
  const ref = db().collection(DEV_OUTBOX[box]).doc();
  await ref.set({ ...data, at: Date.now() });
  return ref.id;
}
