/**
 * The search step's triggers against the Firestore + Storage emulators,
 * invoked in-process with synthetic events (so the event id and timing are
 * ours to control — redelivery is just calling twice with the same id).
 *
 * Counts tests never write the ticket documents themselves: if a functions
 * emulator is also running (root `pnpm test:emu`), its own onTicketWritten
 * would bump the same board. Index tests write tickets but no board doc, so
 * that other trigger's count bump is a no-op there.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { CloudEvent } from 'firebase-functions/v2';
import type { StorageObjectData } from 'firebase-functions/v2/storage';
import { paths, storage as storagePaths, type Board, type Message, type Ticket } from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';
import { setupEmulators, setPorts, uniq } from '../harness/index.js';
import { db, storageAdmin } from '../../src/runtime/firebase.js';
import type { MessageWrittenEvent, TicketWrittenEvent } from '../../src/runtime/functions.js';
import { memorySearchIndex } from '../../src/search/memory.js';
import { PROCESSED_META } from '../../src/search/images.js';
import { TRIGGER_EVENTS } from '../../src/search/sync.js';
import { handleTicketWritten } from '../../src/triggers/onTicketWritten.js';
import { handleMessageWritten } from '../../src/triggers/onMessageWritten.js';
import { handleAttachmentFinalized } from '../../src/triggers/onAttachmentFinalized.js';
import { fileOf, msgOf } from '../tickets/store.js';

setupEmulators();

const NOW = Date.UTC(2026, 8, 22, 12);

const snap = (data: object | undefined) => ({ exists: !!data, data: () => data });
function ticketEvent(
  boardId: string,
  ticketId: string,
  before: Partial<Ticket> | undefined,
  after: Partial<Ticket> | undefined,
  id = uniq('evt'),
): TicketWrittenEvent {
  return {
    id,
    time: new Date(NOW).toISOString(),
    params: { boardId, ticketId },
    data: { before: snap(before), after: snap(after) },
  } as unknown as TicketWrittenEvent;
}
function messageEvent(
  boardId: string,
  ticketId: string,
  before: Partial<Message> | undefined,
  after: Partial<Message> | undefined,
): MessageWrittenEvent {
  return {
    id: uniq('evt'),
    time: new Date(NOW).toISOString(),
    params: { boardId, ticketId, messageId: 'm' },
    data: { before: snap(before), after: snap(after) },
  } as unknown as MessageWrittenEvent;
}

const ticket = (over: Partial<Ticket> = {}): Ticket => ({ ...fixtures.tickets, ...over });
const rt = (text: string) => ({ ...fixtures.messages.body, text });
const message = (text: string, createdAt: number, over: Partial<Message> = {}): Message => ({
  ...fixtures.messages,
  kind: 'comment',
  body: rt(text),
  deletedAt: null,
  createdAt,
  ...over,
});

function useMemoryIndex() {
  const idx = memorySearchIndex();
  setPorts({ search: idx });
  return idx;
}

async function makeBoard(counts: Board['counts'] = { active: 0, done: 0, overdue: 0 }) {
  const boardId = uniq('b_');
  await db()
    .doc(paths.board(boardId))
    .set({ ...fixtures.boards, counts });
  return boardId;
}
const countsOf = async (boardId: string) =>
  (await db().doc(paths.board(boardId)).get()).get('counts') as Board['counts'];

describe('onTicketWritten — board counts', () => {
  it('increments on create, moves between buckets, decrements on delete', async () => {
    useMemoryIndex();
    const b = await makeBoard();
    const t = uniq('t_');
    const todo = ticket({ stageCategory: 'todo', state: 'active', dueAt: null, dueAllDay: false });
    const overdue = { ...todo, dueAt: NOW - 1000 };
    const done = { ...overdue, stageCategory: 'done' as const };

    await handleTicketWritten(ticketEvent(b, t, undefined, todo));
    expect(await countsOf(b)).toEqual({ active: 1, done: 0, overdue: 0 });
    await handleTicketWritten(ticketEvent(b, t, todo, overdue));
    expect(await countsOf(b)).toEqual({ active: 1, done: 0, overdue: 1 });
    await handleTicketWritten(ticketEvent(b, t, overdue, done));
    expect(await countsOf(b)).toEqual({ active: 0, done: 1, overdue: 0 });
    await handleTicketWritten(ticketEvent(b, t, done, { ...done, state: 'archived' }));
    expect(await countsOf(b)).toEqual({ active: 0, done: 0, overdue: 0 });
    await handleTicketWritten(ticketEvent(b, t, undefined, todo));
    await handleTicketWritten(ticketEvent(b, t, todo, undefined));
    expect(await countsOf(b)).toEqual({ active: 0, done: 0, overdue: 0 });
  });

  it('is idempotent by event id — a redelivered event counts once', async () => {
    useMemoryIndex();
    const b = await makeBoard({ active: 40, done: 0, overdue: 0 });
    const t = uniq('t_');
    const ev = ticketEvent(
      b,
      t,
      undefined,
      ticket({ stageCategory: 'active', state: 'active', dueAt: null }),
    );
    await Promise.all([handleTicketWritten(ev), handleTicketWritten(ev)]);
    await handleTicketWritten(ev);
    expect(await countsOf(b)).toEqual({ active: 41, done: 0, overdue: 0 });
    expect((await db().collection(TRIGGER_EVENTS).doc(ev.id).get()).get('boardId')).toBe(b);
  });

  it('ignores a deleted board and derived-only writes', async () => {
    useMemoryIndex();
    const t = ticket({ stageCategory: 'todo', state: 'active', dueAt: null });
    // board never existed: nothing thrown, nothing created
    const ghost = uniq('b_');
    await handleTicketWritten(ticketEvent(ghost, uniq('t_'), undefined, t));
    expect((await db().doc(paths.board(ghost)).get()).exists).toBe(false);
    // rank / counts change: no counts delta, no reindex
    const b = await makeBoard({ active: 3, done: 0, overdue: 0 });
    const idx = useMemoryIndex();
    await handleTicketWritten(
      ticketEvent(b, uniq('t_'), t, { ...t, rank: 'zz', lastActivityAt: NOW }),
    );
    expect(await countsOf(b)).toEqual({ active: 3, done: 0, overdue: 0 });
    expect(idx.all()).toEqual([]);
  });
});

describe('onTicketWritten — search index', () => {
  it('upserts from the CURRENT ticket and its thread, deletes when gone', async () => {
    const idx = useMemoryIndex();
    const b = uniq('b_'); // no board doc (see header)
    const t = uniq('t_');
    // §W: the thread is part of the ticket, so the index reads one document.
    const stored = ticket({
      key: 'ENG-4242',
      title: 'Fix login redirect',
      updatedAt: NOW,
      recentMessages: [{ ...message('the SSO callback loops', NOW - 10), id: 'm1' }],
    });
    await db().doc(paths.ticket(b, t)).set(stored);

    // The event carries a stale title; the index follows Firestore.
    await handleTicketWritten(ticketEvent(b, t, undefined, { ...stored, title: 'stale' }));
    expect(idx.get(t)).toMatchObject({
      id: t,
      boardId: b,
      key: 'ENG-4242',
      title: 'Fix login redirect',
      updatedAt: NOW,
    });
    expect(idx.get(t)!.text).toContain('the SSO callback loops');
    expect((await idx.search({ q: '4242', boardIds: [b] })).hits.map((h) => h.id)).toEqual([t]);

    await db().doc(paths.ticket(b, t)).delete();
    await handleTicketWritten(ticketEvent(b, t, stored, undefined));
    expect(idx.get(t)).toBeUndefined();
  });
});

describe('the thread is part of the ticket (§W)', () => {
  it('folds the last 20 live comments into the index doc — one read, no query', async () => {
    const idx = useMemoryIndex();
    const [b, t] = [uniq('b_'), uniq('t_')];
    const thread = [
      ...Array.from({ length: 23 }, (_, i) => ({
        ...message(`note${i + 1}`, NOW + i + 1),
        id: `m${i + 1}`,
      })),
      { ...message('moved to QA', NOW + 30, { kind: 'system' }), id: 'sys' },
      { ...message('secret', NOW + 31, { deletedAt: NOW }), id: 'del' },
    ];
    const stored = ticket({ description: null, recentMessages: thread });
    await db().doc(paths.ticket(b, t)).set(stored);

    // Posting a comment IS a ticket write now: onTicketWritten is the only
    // trigger that has to notice it.
    await handleTicketWritten(
      ticketEvent(b, t, ticket({ description: null, recentMessages: [] }), stored),
    );
    const lines = idx.get(t)!.text.split('\n');
    expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => `note${i + 4}`));
    expect((await idx.search({ q: 'note23', boardIds: [b] })).found).toBe(1);
    expect((await idx.search({ q: 'secret', boardIds: [b] })).found).toBe(0);
  });

  it('skips writes that change no text, and never resurrects a missing ticket', async () => {
    const idx = useMemoryIndex();
    const [b, t] = [uniq('b_'), uniq('t_')];
    const m = { ...message('hello', NOW), id: 'm1' };
    const before = ticket({ recentMessages: [m] });
    // A reaction changes no indexed text.
    await handleTicketWritten(
      ticketEvent(
        b,
        t,
        before,
        ticket({ recentMessages: [{ ...m, reactions: { '\u{1F44D}': ['u'] } }] }),
      ),
    );
    expect(idx.all()).toEqual([]);
    // A new comment on a ticket that is already gone must not resurrect it.
    await handleTicketWritten(ticketEvent(b, t, undefined, ticket({ recentMessages: [m] })));
    expect(idx.all()).toEqual([]);
  });

  it('the leftover onMessageWritten trigger converges instead of resurrecting old text', async () => {
    // Pass 2 of the migration deletes the old subcollection; each delete lands
    // in this trigger, which rebuilds from the CURRENT ticket.
    const idx = useMemoryIndex();
    const [b, t] = [uniq('b_'), uniq('t_')];
    await handleMessageWritten(messageEvent(b, t, message('old text', NOW), undefined));
    expect(idx.all()).toEqual([]);
  });
});

describe('onAttachmentFinalized', () => {
  const bucket = () => storageAdmin().bucket();
  const png = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#3366cc' } })
      .png()
      .toBuffer();
  const finalized = async (name: string): Promise<CloudEvent<StorageObjectData>> => {
    const [m] = await bucket().file(name).getMetadata();
    return {
      id: uniq('evt'),
      source: 'test',
      specversion: '1.0',
      type: 'google.cloud.storage.object.v1.finalized',
      time: new Date().toISOString(),
      data: {
        name,
        bucket: bucket().name,
        contentType: m.contentType,
        metadata: m.metadata as Record<string, string> | undefined,
      } as StorageObjectData,
    };
  };

  it('writes thumb_400.webp and patches the ticket\u2019s file row and its message', async () => {
    const [b, t, a] = [uniq('b_'), uniq('t_'), uniq('a_')];
    const path = storagePaths.attachment(b, t, a, 'photo.png');
    await bucket()
      .file(path)
      .save(await png(1200, 800), { contentType: 'image/png', resumable: false });
    const att = { id: a, path, name: 'photo.png', mime: 'image/png', size: 1, uploadedBy: 'u' };
    // §W: the message and its file row are both fields of the ticket.
    await db()
      .doc(paths.ticket(b, t))
      .set(
        ticket({
          recentMessages: [{ ...message('see pic', NOW, { attachments: [att] }), id: 'm1' }],
          files: [{ ...att, source: 'message', messageId: 'm1', createdAt: NOW, deletedAt: null }],
          fileIds: [a],
        }),
      );

    const res = await handleAttachmentFinalized(await finalized(path));
    const thumbPath = storagePaths.thumb(b, t, a);
    expect(res).toEqual({ kind: 'thumbnail', thumbPath, width: 1200, height: 800, patched: 1 });

    const [thumb] = await bucket().file(thumbPath).download();
    expect(await sharp(thumb).metadata()).toMatchObject({
      format: 'webp',
      width: 400,
      height: 267,
    });
    expect(await fileOf(b, t, a)).toMatchObject({ width: 1200, height: 800, thumbPath });
    const msg = (await msgOf(b, t, 'm1')) as Message;
    expect(msg.attachments[0]).toMatchObject({ id: a, width: 1200, height: 800, thumbPath });
    const [meta] = await bucket().file(path).getMetadata();
    expect(meta.metadata).toMatchObject({ width: '1200', height: '800', thumbPath });

    // The thumbnail's own finalize event is ignored.
    expect((await handleAttachmentFinalized(await finalized(thumbPath))).kind).toBe('skipped');
  });

  it('skips non-images and undecodable files', async () => {
    const [b, t] = [uniq('b_'), uniq('t_')];
    const pdf = storagePaths.attachment(b, t, 'a1', 'doc.pdf');
    await bucket()
      .file(pdf)
      .save(Buffer.from('%PDF-1.4'), { contentType: 'application/pdf', resumable: false });
    expect(await handleAttachmentFinalized(await finalized(pdf))).toEqual({
      kind: 'skipped',
      reason: 'not a raster image',
    });
    const bad = storagePaths.attachment(b, t, 'a2', 'x.png');
    await bucket()
      .file(bad)
      .save(Buffer.from('nope'), { contentType: 'image/png', resumable: false });
    expect((await handleAttachmentFinalized(await finalized(bad))).kind).toBe('skipped');
  });

  it('replaces an avatar with a 256px square webp, once', async () => {
    const path = storagePaths.avatar(uniq('u_'), NOW);
    await bucket()
      .file(path)
      .save(await png(800, 500), { contentType: 'image/png', resumable: false });
    expect(await handleAttachmentFinalized(await finalized(path))).toEqual({ kind: 'avatar' });
    const [data] = await bucket().file(path).download();
    expect(await sharp(data).metadata()).toMatchObject({ format: 'webp', width: 256, height: 256 });
    const again = await finalized(path);
    expect(again.data.metadata?.[PROCESSED_META]).toBe('avatar');
    expect((await handleAttachmentFinalized(again)).kind).toBe('skipped');
  });
});
