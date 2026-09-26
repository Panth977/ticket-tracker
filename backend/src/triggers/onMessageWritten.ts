/**
 * boards/{b}/tickets/{t}/messages/{messageId} onWrite.
 *
 * Phase 15 (§W) moved the thread INTO the ticket document, so nothing writes
 * this path any more and onTicketWritten sees every message
 * (search/doc.ts indexedFieldsChanged compares the folded thread text).
 *
 * The trigger stays registered for the migration window: pass 2 of
 * scripts/migrate-ticket-doc.mjs deletes the old subcollection, and each
 * delete lands here. Rebuilding the index from the CURRENT ticket
 * (sync.reindexTicket) makes that — and any redelivered or out-of-order
 * event — converge on the present state instead of resurrecting old text.
 */
import type { Message } from '@tm/shared';
import { defineTrigger, type MessageWrittenEvent } from '../runtime/functions.js';
import { isIndexedMessage } from '../search/doc.js';
import { reindexTicket } from '../search/sync.js';

/** Whether this message write can change the folded text. */
export function messageTextChanged(
  before: Message | undefined,
  after: Message | undefined,
): boolean {
  const text = (m: Message | undefined) => (m && isIndexedMessage(m) ? m.body.text : null);
  return text(before) !== text(after);
}

export async function handleMessageWritten(event: MessageWrittenEvent): Promise<void> {
  const { boardId, ticketId } = event.params;
  const before = event.data?.before.exists ? (event.data.before.data() as Message) : undefined;
  const after = event.data?.after.exists ? (event.data.after.data() as Message) : undefined;
  if (!messageTextChanged(before, after)) return;
  // Ticket gone (deleted with its thread): its own event owns the index doc.
  await reindexTicket(boardId, ticketId, { onMissing: 'ignore' });
}

defineTrigger('onMessageWritten', handleMessageWritten);
