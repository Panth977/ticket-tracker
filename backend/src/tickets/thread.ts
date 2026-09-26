/**
 * Shared bits of the thread commands (messagePost / Edit / Pin / React).
 *
 * Phase 15 (§W): a message is a row inside the ticket document, so 'load the
 * message' is 'find it on the ticket' — inline, or in the data page it spilled
 * into. That lookup belongs to the transaction's READ phase, which is why it
 * is async and takes the writer.
 */
import { errors, type Message } from '@tm/shared';
import type { FoundMessage, TicketWriter } from './doc.js';

/** A message of this ticket, wherever it lives, or 404. */
export async function loadMessage(w: TicketWriter, messageId: string): Promise<FoundMessage> {
  const found = await w.locate(messageId);
  if (!found) throw errors.not_found('Message not found');
  return found;
}

export function requireNotDeleted(m: Pick<Message, 'deletedAt'>): void {
  if (m.deletedAt !== null) throw errors.conflict('This message was deleted');
}
