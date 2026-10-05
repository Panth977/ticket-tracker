/**
 * ONE DOCUMENT PER TICKET (docs/plan/agents.html §W), end to end:
 *
 *   · a board open is ONE query, and opening a ticket costs nothing more —
 *     the thread, the activity, the files, the task lists and the card's
 *     rollup signals are all on the document the board already read;
 *   · a long thread SPILLS into boards/{b}/tickets/{t}/data/{NNN} and reads
 *     back in order;
 *   · scripts/migrate-ticket-doc.mjs folds the old subcollections into the
 *     document, verifies the fold, then deletes them — and is a no-op when
 *     run twice.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KEEP_INLINE_MESSAGES,
  MAX_INLINE_MESSAGES,
  paths,
  type Activity,
  type Message,
  type StoredTasklist,
  type Ticket,
  type TicketDataPage,
  type TicketFile,
} from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { readThread } from '../../src/tickets/read.js';
import { call, setupEmulators, uniq } from '../harness/index.js';
import {
  doc,
  getDocData,
  people,
  putMemoryObject,
  seedAttachMemory,
  seedBoard,
  spyPorts,
} from './helpers.js';
import { actsOf, filesOf, listsOf, msgsOf, pagesOf } from './store.js';

setupEmulators();

const T = (b: string, t: string) => getDocData<Ticket>(paths.ticket(b, t)).then((x) => x!);
const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The migration, as a real `node scripts/…` run against the emulator. */
async function migrate(...args: string[]): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    ['scripts/migrate-ticket-doc.mjs', '--project', 'demo-taskmanager', ...args],
    { cwd: ROOT, env: { ...process.env } },
  );
  return stdout;
}

describe('the ticket IS the thread (§W)', () => {
  it('one document carries the messages, activity, files, task lists and signals', async () => {
    spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'W' });

    await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('hello'),
      clientId: uniq('c'),
    });
    await call(asha, 'tasklistSet', {
      boardId: b.id,
      ticketId,
      listId: 'plan',
      title: 'Plan',
      items: [
        { title: 'one', status: 'done' },
        { title: 'two', status: 'doing' },
      ],
    });

    const t = await T(b.id, ticketId);
    // Everything a card renders, on the document the board already read.
    expect(t.recentMessages?.map((m) => m.body.text)).toEqual(['hello', 'asha added a plan: Plan']);
    expect(t.recentActivity?.map((a) => a.action)).toEqual(['create']);
    expect(t.tasklists?.map((l) => l.id)).toEqual(['plan']);
    expect(t.pageCount).toBe(0);
    expect(t.oldestInlineAt).toBe(t.recentActivity![0]!.createdAt);
    expect(t.signals).toMatchObject({
      messageCount: 2,
      fileCount: 0,
      blocked: false,
      tasklist: { done: 1, total: 2, working: 'two' },
    });
    expect(t.signals!.unreadFrom).toBe(t.recentMessages![0]!.createdAt);
    expect(t.signals!.lastMessageAt).toBe(t.lastMessageAt);
    // …and nothing is left in the old subcollections.
    for (const sub of ['messages', 'activity', 'files', 'tasklists'])
      expect(
        (
          await db()
            .collection(`${paths.ticket(b.id, ticketId)}/${sub}`)
            .get()
        ).size,
      ).toBe(0);
  });

  it('a question and a pin stay inline, and settle the card signals', async () => {
    spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Q' });
    const { messageId } = await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('pin me'),
      clientId: uniq('c'),
    });
    await call(asha, 'messagePin', { boardId: b.id, ticketId, messageId, pinned: true });
    const q = await call(asha, 'questionAsk', {
      boardId: b.id,
      ticketId,
      title: 'Which database?',
      fields: [{ id: 'f', label: 'Pick', type: 'text' }],
      clientId: uniq('q'),
    });

    let t = await T(b.id, ticketId);
    expect(t.signals!.question).toMatchObject({ title: 'Which database?', count: 1 });
    expect(t.signals!.blocked).toBe(true);
    expect(t.waitingOn).toMatchObject({ messageId: q.messageId });
    expect(t.nextQuestionExpiresAt).toBeNull();
    expect(t.counts.pinned).toBe(1);

    await call(priya, 'questionAnswer', {
      boardId: b.id,
      ticketId,
      messageId: q.messageId,
      values: { f: 'Postgres' },
    });
    t = await T(b.id, ticketId);
    expect(t.signals!.question).toBeNull();
    expect(t.signals!.blocked).toBe(false);
  });

  it('a file arrives, is attached to a message, and is found by id', async () => {
    const s = spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'F' });
    const memoryId = await seedAttachMemory(b.id, asha);
    const up = await putMemoryObject(
      s.files,
      memoryId,
      'log.txt',
      new Uint8Array(42),
      'text/plain',
    );
    await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('see log'),
      memoryUploads: [{ memoryId, path: 'logs/log.txt', storagePath: up.storagePath }],
      clientId: uniq('c'),
    });
    const t = await T(b.id, ticketId);
    expect(t.files).toHaveLength(1);
    expect(t.fileIds).toEqual([t.files![0]!.id]);
    expect(t.signals!.fileCount).toBe(1);
    expect(t.counts.files).toBe(1);
    // The one collection-group query GET /v1/files/{id} runs.
    const found = await db()
      .collectionGroup('tickets')
      .where('fileIds', 'array-contains', t.files![0]!.id)
      .get();
    expect(found.docs.map((d) => d.id)).toEqual([ticketId]);
  });
});

describe('the spill (§W)', () => {
  it('2,000 messages page correctly and read back in order', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Long' });

    // Posting 2,000 through the command layer would be 2,000 transactions;
    // the fold is what is under test, so seed the rows and let the migration
    // (the SAME planSpill the commands use) do the paging.
    const base = Date.now() - 2_000_000;
    const batchSize = 400;
    for (let i = 0; i < 2_000; i += batchSize) {
      const batch = db().batch();
      for (let j = i; j < Math.min(i + batchSize, 2_000); j++) {
        const m: Message = {
          kind: 'comment',
          body: { doc: { type: 'doc', content: [] }, text: `note ${j}`, mentions: [], refs: [] },
          authorUid: asha.uid,
          authorName: 'Asha',
          via: 'app',
          replyTo: null,
          attachments: [],
          reactions: {},
          pinnedAt: null,
          pinnedBy: null,
          editedAt: null,
          deletedAt: null,
          createdAt: base + j,
        };
        batch.set(
          db().doc(`${paths.ticket(b.id, ticketId)}/messages/m${String(j).padStart(5, '0')}`),
          m,
        );
      }
      await batch.commit();
    }
    await db().doc(paths.ticket(b.id, ticketId)).update({ recentMessages: [], signals: null });

    await migrate('--apply', '--board', b.id);

    const t = await T(b.id, ticketId);
    expect(t.counts.messages).toBe(2_000);
    expect(t.signals!.messageCount).toBe(2_000);
    expect(t.recentMessages!.length).toBeLessThanOrEqual(MAX_INLINE_MESSAGES);
    // 2,000 short messages fold into one 700 KB page; a thread that GROWS a
    // message at a time makes one page per ~100 (see spill.test.ts).
    expect(t.pageCount).toBeGreaterThanOrEqual(1);
    expect(await pagesOf(b.id, ticketId)).toBe(t.pageCount);

    // Ascending, descending and a cursor all read the same thread.
    const asc = await msgsOf(b.id, ticketId);
    expect(asc).toHaveLength(2_000);
    expect(asc.map((m) => m.body.text)).toEqual(
      Array.from({ length: 2_000 }, (_, i) => `note ${i}`),
    );
    const desc = await readThread(b.id, ticketId, { ticket: t, order: 'desc', limit: 5 });
    expect(desc.rows.map((m) => m.body.text)).toEqual([
      'note 1999',
      'note 1998',
      'note 1997',
      'note 1996',
      'note 1995',
    ]);
    const first = await readThread(b.id, ticketId, { ticket: t, order: 'asc', limit: 3 });
    expect(first.hasMore).toBe(true);
    const next = await readThread(b.id, ticketId, {
      ticket: t,
      order: 'asc',
      limit: 3,
      after: { createdAt: first.rows[2]!.createdAt, id: first.rows[2]!.id },
    });
    expect(next.rows.map((m) => m.body.text)).toEqual(['note 3', 'note 4', 'note 5']);
    // oldestInlineAt is the boundary a reader pages back from.
    expect(t.oldestInlineAt).toBe(t.recentMessages![0]!.createdAt);
  });

  it('a new message spills the oldest chunk in the same write', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Grow' });
    // Right up to the edge, then one more through the command layer.
    const base = Date.now() - 500_000;
    const rows = Array.from({ length: MAX_INLINE_MESSAGES }, (_, j) => ({
      id: `s${String(j).padStart(5, '0')}`,
      kind: 'comment' as const,
      body: {
        doc: { type: 'doc' as const, content: [] },
        text: `old ${j}`,
        mentions: [],
        refs: [],
      },
      authorUid: asha.uid,
      authorName: 'Asha',
      via: 'app' as const,
      replyTo: null,
      attachments: [],
      reactions: {},
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: base + j,
    }));
    await db()
      .doc(paths.ticket(b.id, ticketId))
      .update({ recentMessages: rows, 'counts.messages': rows.length });

    expect(await pagesOf(b.id, ticketId)).toBe(0);
    await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('the straw'),
      clientId: uniq('c'),
    });

    const t = await T(b.id, ticketId);
    expect(t.pageCount).toBe(1);
    expect(t.recentMessages).toHaveLength(KEEP_INLINE_MESSAGES);
    expect(t.recentMessages![t.recentMessages!.length - 1]!.body.text).toBe('the straw');
    const page = (await getDocData<TicketDataPage>(paths.ticketPage(b.id, ticketId, 0)))!;
    expect(page.messages[0]!.body.text).toBe('old 0');
    expect(page.from).toBe(base);
    expect(await msgsOf(b.id, ticketId)).toHaveLength(MAX_INLINE_MESSAGES + 1);
  });
});

describe('scripts/migrate-ticket-doc.mjs', () => {
  it('folds the old subcollections in, verifies, prunes — and is a no-op twice', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Legacy' });
    const at = paths.ticket(b.id, ticketId);
    const now = Date.now() - 10_000;

    // A ticket as phase 14 left it: four subcollections, no §W fields.
    const message: Message = {
      kind: 'comment',
      body: {
        doc: { type: 'doc', content: [] },
        text: 'from the old world',
        mentions: [],
        refs: [],
      },
      authorUid: asha.uid,
      authorName: 'Asha',
      via: 'app',
      replyTo: null,
      attachments: [],
      reactions: {},
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: now,
    };
    const activity: Activity = {
      action: 'update',
      changes: { title: { from: 'a', to: 'b' } },
      actor: asha.uid,
      via: 'app',
      createdAt: now + 1,
    };
    const file: TicketFile = {
      id: 'att_old',
      path: `boards/${b.id}/tickets/${ticketId}/att_old/old.txt`,
      name: 'old.txt',
      mime: 'text/plain',
      size: 3,
      uploadedBy: asha.uid,
      source: 'message',
      messageId: 'm_old',
      createdAt: now,
      deletedAt: null,
    };
    const list: StoredTasklist = {
      id: 'tl_old',
      title: 'Old plan',
      owner: asha.uid,
      items: [{ id: 'i1', title: 'one', status: 'done', updatedAt: now }],
      position: 0,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    const { id: _listId, ...listDoc } = list;
    const seed = db().batch();
    seed.set(db().doc(`${at}/messages/m_old`), message);
    seed.set(db().doc(`${at}/activity/a_old`), activity);
    seed.set(db().doc(`${at}/files/att_old`), file);
    seed.set(db().doc(`${at}/tasklists/tl_old`), listDoc);
    seed.update(db().doc(at), {
      recentMessages: [],
      recentActivity: [],
      files: [],
      fileIds: [],
      tasklists: [],
      signals: null,
      counts: { messages: 0, files: 0, pinned: 0 },
    });
    await seed.commit();

    // Dry run writes nothing.
    const dry = await migrate('--board', b.id);
    expect(dry).toContain('DRY RUN');
    expect((await T(b.id, ticketId)).recentMessages).toEqual([]);

    await migrate('--apply', '--board', b.id);
    let t = await T(b.id, ticketId);
    expect(t.recentMessages!.map((m) => m.id)).toEqual(['m_old']);
    expect(t.recentActivity!.map((a) => a.id)).toEqual(['a_old']);
    expect(t.files!.map((f) => f.id)).toEqual(['att_old']);
    expect(t.tasklists!.map((l) => l.id)).toEqual(['tl_old']);
    expect(t.counts).toMatchObject({ messages: 1, files: 1, pinned: 0 });
    expect(t.signals).toMatchObject({ messageCount: 1, fileCount: 1 });
    expect(t.tasklistProgress).toEqual({ done: 1, total: 1 });

    // Folding twice changes nothing (the marker makes it a skip).
    const second = await migrate('--apply', '--board', b.id);
    expect(second).toContain('folded 0');
    t = await T(b.id, ticketId);
    expect(t.recentMessages!.map((m) => m.id)).toEqual(['m_old']);

    // Pass 2 verifies, then deletes.
    await migrate('--prune', '--apply', '--board', b.id);
    for (const sub of ['messages', 'activity', 'files', 'tasklists'])
      expect((await db().collection(`${at}/${sub}`).get()).size).toBe(0);
    expect(await msgsOf(b.id, ticketId)).toHaveLength(1);
    expect(await actsOf(b.id, ticketId)).toHaveLength(1);
    expect(await filesOf(b.id, ticketId)).toHaveLength(1);
    expect(await listsOf(b.id, ticketId)).toHaveLength(1);

    // …and a third run of either pass is a no-op that keeps the fold.
    await migrate('--apply', '--board', b.id);
    await migrate('--prune', '--apply', '--board', b.id);
    t = await T(b.id, ticketId);
    expect(t.recentMessages!.map((m) => m.id)).toEqual(['m_old']);
    expect(t.counts.messages).toBe(1);
  });
});
