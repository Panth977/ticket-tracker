/**
 * Reading and seeding a ticket's thread in tests, the §W way.
 *
 * Phase 15 folded messages, activity, files and task lists INTO the ticket
 * document, so a test that used to read a subcollection reads a field — and a
 * test that used to `set()` a message document appends a row. These helpers
 * are the one place that knows that, so the assertions in every suite stayed
 * the assertions they were.
 */
import {
  paths,
  type Activity,
  type Message,
  type StoredTasklist,
  type TicketFile,
} from '@tm/shared';
import { ports } from '../../src/adapters/index.js';
import { db } from '../../src/runtime/firebase.js';
import { runTx } from '../../src/runtime/tx.js';
import { openTicket } from '../../src/tickets/doc.js';
import {
  getMessage,
  readActivity,
  readAllMessages,
  readFiles,
  readTasklists,
} from '../../src/tickets/read.js';

const ctx = () => ({ now: ports().clock.now(), ids: ports().ids });

/** Every message on the ticket, oldest first (inline and paged). */
export const msgsOf = (boardId: string, ticketId: string) => readAllMessages(boardId, ticketId);

/** One message by id, or undefined. */
export const msgOf = (boardId: string, ticketId: string, messageId: string) =>
  getMessage(boardId, ticketId, messageId);

/** Every activity row, oldest first. */
export const actsOf = (boardId: string, ticketId: string) =>
  readActivity(boardId, ticketId, { order: 'asc' });

/** Every file row, tombstones included. */
export const filesOf = (boardId: string, ticketId: string) =>
  readFiles(boardId, ticketId, { live: false });

/** Every task list, in position order. */
export const listsOf = (boardId: string, ticketId: string) => readTasklists(boardId, ticketId);

/** How many data pages the ticket has spilled. */
export const pagesOf = async (boardId: string, ticketId: string): Promise<number> =>
  (await db().collection(paths.ticketData(boardId, ticketId)).get()).size;

/** Append a message the way a command would (counters and signals follow). */
export async function putMessage(
  boardId: string,
  ticketId: string,
  messageId: string,
  message: Message,
): Promise<void> {
  await runTx(async (tx) => {
    const w = await openTicket(tx, ctx(), boardId, ticketId);
    w.addMessage(messageId, message);
    w.commit();
  });
}

/** Change a message in place (an edit, a pin, a question answered …). */
export async function patchMessage(
  boardId: string,
  ticketId: string,
  messageId: string,
  patch: Partial<Message>,
): Promise<void> {
  await runTx(async (tx) => {
    const w = await openTicket(tx, ctx(), boardId, ticketId);
    const found = await w.locate(messageId);
    if (!found) throw new Error(`putMessage: no message ${messageId}`);
    w.patchMessage(found, patch);
    w.commit();
  });
}

export async function putActivity(
  boardId: string,
  ticketId: string,
  activity: Activity,
  id?: string,
): Promise<void> {
  await runTx(async (tx) => {
    const w = await openTicket(tx, ctx(), boardId, ticketId);
    w.addActivity(activity, id);
    w.commit();
  });
}

export async function putFile(boardId: string, ticketId: string, file: TicketFile): Promise<void> {
  await runTx(async (tx) => {
    const w = await openTicket(tx, ctx(), boardId, ticketId);
    w.addFiles([file]);
    w.commit();
  });
}

export async function putTasklist(
  boardId: string,
  ticketId: string,
  list: StoredTasklist,
): Promise<void> {
  await runTx(async (tx) => {
    const w = await openTicket(tx, ctx(), boardId, ticketId);
    w.setTasklist(list);
    w.commit();
  });
}

/** One file row by id. */
export const fileOf = async (boardId: string, ticketId: string, fileId: string) =>
  (await filesOf(boardId, ticketId)).find((f) => f.id === fileId);

/** One task list by id. */
export const listOf = async (boardId: string, ticketId: string, listId: string) =>
  (await listsOf(boardId, ticketId)).find((l) => l.id === listId);
