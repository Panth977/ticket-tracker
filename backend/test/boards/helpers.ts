/** Shared setup for the cmd-boards emulator tests. */
import { paths, rtdb, type Board, type BoardMember, type View } from '@tm/shared';
import { db, rtdbAdmin } from '../../src/runtime/firebase.js';
import { call, createUser, uniq, type TestUser } from '../harness/index.js';

/** A fresh, unique board key (2–6 chars, A–Z then A–Z/0–9). */
export function uniqKey(): string {
  const s = uniq()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return ('K' + s.slice(-5)).slice(0, 6);
}

export async function getBoard(boardId: string): Promise<Board | undefined> {
  const s = await db().doc(paths.board(boardId)).get();
  return s.exists ? (s.data() as Board) : undefined;
}

export async function getMember(boardId: string, uid: string): Promise<BoardMember | undefined> {
  const s = await db().doc(paths.member(boardId, uid)).get();
  return s.exists ? (s.data() as BoardMember) : undefined;
}

export async function getViews(boardId: string): Promise<(View & { id: string })[]> {
  const s = await db().collection(paths.views(boardId)).get();
  return s.docs.map((d) => ({ id: d.id, ...(d.data() as View) }));
}

export async function readers(boardId: string): Promise<Record<string, true> | null> {
  const s = await rtdbAdmin().ref(rtdb.boardReaders(boardId)).get();
  return s.exists() ? (s.val() as Record<string, true>) : null;
}

export async function newBoard(
  owner: TestUser,
  extra: Record<string, unknown> = {},
): Promise<{ boardId: string; key: string }> {
  const key = uniqKey();
  const { boardId } = await call(owner, 'boardCreate', { name: 'Engineering', key, ...extra });
  return { boardId, key };
}

/**
 * Put `user` on the board with `role` directly (bypassing invites) — for tests
 * of other commands. Keeps access / readerUids / editorUids / members in step.
 */
export async function addMember(boardId: string, user: TestUser, role: Board['access'][string]) {
  await db().runTransaction(async (tx) => {
    const ref = db().doc(paths.board(boardId));
    const b = (await tx.get(ref)).data() as Board;
    const access = { ...b.access, [user.uid]: role };
    const uids = Object.keys(access).sort();
    tx.update(ref, {
      access,
      readerUids: uids,
      editorUids: uids.filter((u) => access[u] === 'admin' || access[u] === 'editor'),
    });
    const m: BoardMember = {
      uid: user.uid,
      role,
      stageGrant: null,
      name: user.displayName,
      email: user.email,
      avatarPath: null,
      invitedBy: null,
      joinedAt: Date.now(),
    };
    tx.set(db().doc(paths.member(boardId, user.uid)), m);
  });
}

/** Write a minimal valid ticket straight to Firestore (ticket commands belong to cmd-tickets). */
export async function seedTicket(
  boardId: string,
  over: Partial<Record<string, unknown>> & { stageId: string },
): Promise<string> {
  const id = uniq('t');
  const b = (await getBoard(boardId))!;
  const n = Math.floor(Math.random() * 1e6) + 1;
  const stage = b.stages.find((s) => s.id === over.stageId)!;
  await db()
    .doc(paths.ticket(boardId, id))
    .set({
      key: `${b.key}-${n}`,
      number: n,
      title: 'A ticket',
      description: null,
      stageCategory: stage.category,
      priorityId: null,
      tagIds: [],
      state: 'active',
      rank: 'a0',
      assigneeUids: [],
      watcherUids: [],
      reporter: { uid: null, name: 'x' },
      startAt: null,
      dueAt: null,
      dueAllDay: false,
      commitments: {},
      estimate: null,
      fields: {},
      refs: [],
      referencedBy: [],
      links: [],
      counts: { messages: 0, files: 0, pinned: 0 },
      lastMessageAt: null,
      lastActivityAt: 1,
      dueNotified: {},
      createdBy: 'seed',
      createdVia: 'app',
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
      ...over,
    });
  return id;
}

export { createUser, call, uniq };
