/**
 * Fixtures for the ticket / thread command tests: boards seeded straight
 * into Firestore (so these tests do not depend on boardCreate), an in-memory
 * Storage port, and spies on notify / emitWebhook.
 */
import type {
  NotifyEvent,
  NotifyExtra,
  StorageFiles,
  StoredObject,
  WebhookEvent,
} from '@tm/shared';
import type { CommandReq } from '@tm/shared';
import {
  DEFAULT_ATTACH_TEMPLATE,
  bucketStoragePath,
  paths,
  type Board,
  type BoardMember,
  type BoardRole,
  type Bucket,
  type StageGrant,
} from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { fakeDrive } from '../../src/bucket/drive/api.js';
import { forgetDriveBoardIds } from '../../src/db/drive/board.js';
import { DRIVE_LINKS, seal } from '../../src/bucket/drive/link.js';
import { DRIVE_SCOPE } from '@tm/shared';
import { createUser, setPorts, uniq, type TestUser } from '../harness/index.js';

/** What commands accept as a rich-text body (the zod input side). */
export type RichTextDocInput = CommandReq<'ticketCreate'>['description'] & object;

// ─── Storage ────────────────────────────────────────────────────────────────

export interface BucketFiles extends StorageFiles {
  put(path: string, size?: number, contentType?: string): void;
  has(path: string): boolean;
  paths(): string[];
}

export function bucketFiles(): BucketFiles {
  const objs = new Map<string, StoredObject>();
  return {
    put(path, size = 10, contentType = 'image/png') {
      objs.set(path, { path, size, contentType });
    },
    has: (p) => objs.has(p),
    paths: () => [...objs.keys()].sort(),
    async stat(p) {
      return objs.get(p) ?? null;
    },
    async read() {
      return new Uint8Array();
    },
    async write(p, data, contentType) {
      objs.set(p, { path: p, size: data.length, contentType });
    },
    async copy(from, to) {
      const o = objs.get(from);
      if (!o) throw new Error(`copy: no ${from}`);
      objs.set(to, { ...o, path: to });
    },
    async delete(p) {
      objs.delete(p);
    },
    async deletePrefix(prefix) {
      for (const k of [...objs.keys()]) if (k.startsWith(prefix)) objs.delete(k);
    },
    async list(prefix) {
      return [...objs.values()].filter((o) => o.path.startsWith(prefix));
    },
    async signedUploadUrl(p) {
      return `mem://${p}`;
    },
    async signedDownloadUrl(p) {
      return `mem://${p}`;
    },
  };
}

// ─── side-effect spies ──────────────────────────────────────────────────────

export interface Spies {
  notified: { event: NotifyEvent; ticketId: string | null; extra?: NotifyExtra }[];
  emitted: { boardId: string; event: WebhookEvent; data: unknown }[];
  files: BucketFiles;
}

/** Swap notify / emitWebhook / files for recorders (reset by setupEmulators' afterEach). */
export function spyPorts(): Spies {
  const s: Spies = { notified: [], emitted: [], files: bucketFiles() };
  setPorts({
    files: s.files,
    notify: async (event, ticket, _ctx, extra) => {
      s.notified.push({ event, ticketId: ticket?.id ?? null, ...(extra ? { extra } : {}) });
    },
    emitWebhook: async (boardId, event, data) => {
      s.emitted.push({ boardId, event, data });
    },
  });
  return s;
}

// ─── boards ─────────────────────────────────────────────────────────────────

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = LETTERS + '0123456789';
function randomBoardKey(): string {
  let k = LETTERS[Math.floor(Math.random() * 26)]!;
  for (let i = 0; i < 5; i++) k += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return k;
}

export const STAGES = {
  todo: 'st_todo',
  doing: 'st_doing',
  review: 'st_rev',
  done: 'st_done',
} as const;

export interface SeedOptions {
  admin: TestUser;
  editors?: TestUser[];
  commenters?: TestUser[];
  viewers?: TestUser[];
  grants?: Record<string, StageGrant>;
  allowDelete?: boolean;
  patch?: Partial<Board>;
  /** Tickets in (fake) Google Drive (bucket.html §L). Default: TM_TEST_DRIVE_BOARDS. */
  drive?: boolean;
}

export interface SeededBoard {
  id: string;
  key: string;
  board: Board;
}

/** A board with 4 stages, 2 priorities, 2 tags and a few custom fields. */
export async function seedBoard(o: SeedOptions): Promise<SeededBoard> {
  const id = uniq('b');
  const key = randomBoardKey();
  const people: [TestUser, BoardRole][] = [
    [o.admin, 'admin'],
    ...(o.editors ?? []).map((u) => [u, 'editor'] as [TestUser, BoardRole]),
    ...(o.commenters ?? []).map((u) => [u, 'commenter'] as [TestUser, BoardRole]),
    ...(o.viewers ?? []).map((u) => [u, 'viewer'] as [TestUser, BoardRole]),
  ];
  const access = Object.fromEntries(people.map(([u, r]) => [u.uid, r]));
  const board: Board = {
    name: `Board ${key}`,
    key,
    nextNumber: 1,
    color: '#2f6fed',
    icon: 'code',
    description: null,
    access,
    stageGrants: o.grants ?? {},
    readerUids: people.map(([u]) => u.uid),
    editorUids: people.filter(([, r]) => r === 'admin' || r === 'editor').map(([u]) => u.uid),
    stages: [
      { id: STAGES.todo, name: 'To do', color: '#888', category: 'todo', position: 0 },
      { id: STAGES.doing, name: 'Doing', color: '#08f', category: 'active', position: 1 },
      { id: STAGES.review, name: 'Review', color: '#fa0', category: 'active', position: 2 },
      {
        id: STAGES.done,
        name: 'Done',
        color: '#0a0',
        category: 'done',
        position: 3,
        requires: ['f_soluti'],
      },
    ],
    priorities: [
      { id: 'p_high', name: 'High', position: 0 },
      { id: 'p_low', name: 'Low', position: 1 },
    ],
    tags: [
      { id: 'tg_bug', name: 'bug', position: 0 },
      { id: 'tg_ui', name: 'ui', position: 1 },
    ],
    fields: [
      { id: 'f_soluti', name: 'Solution', type: 'longText', position: 0 },
      {
        id: 'f_client',
        name: 'Client',
        type: 'select',
        options: [{ id: 'o_acme', name: 'Acme', position: 0 }],
        position: 1,
      },
      { id: 'f_points', name: 'Points', type: 'number', position: 2 },
      { id: 'f_ownerx', name: 'Owner', type: 'person', position: 3 },
    ],
    defaultViewId: 'v_board',
    settings: {
      allowDelete: o.allowDelete ?? false,
      emailReplies: true,
      autoArchiveDoneAfterDays: null,
    },
    counts: { active: 0, done: 0, overdue: 0 },
    archivedAt: null,
    createdBy: o.admin.uid,
    createdAt: Date.now(),
    ...o.patch,
  };
  // bucket.html §L: TM_TEST_DRIVE_BOARDS=1 runs every ticket test against a
  // board whose tickets live in (the fake) Google Drive.
  if (o.drive ?? process.env.TM_TEST_DRIVE_BOARDS === '1')
    board.storage = await fakeDriveBoard(o.admin, key);
  const batch = db().batch();
  batch.set(db().doc(paths.board(id)), board);
  for (const [u, role] of people) {
    const m: BoardMember = {
      kind: 'user',
      uid: u.uid,
      role,
      stageGrant: role === 'commenter' ? (o.grants?.[u.uid] ?? null) : null,
      name: u.displayName,
      email: u.email,
      avatarPath: null,
      invitedBy: null,
      joinedAt: Date.now(),
    };
    batch.set(db().doc(paths.member(id, u.uid)), m);
  }
  await batch.commit();
  if (board.storage) forgetDriveBoardIds();
  return { id, key, board };
}

/** `u`'s (fake) Google Drive, connected — as if they went through Account › Google Drive. */
export async function connectFakeDrive(u: TestUser): Promise<void> {
  const now = Date.now();
  const ref = db().doc(`${DRIVE_LINKS}/${u.uid}`);
  if (!(await ref.get()).exists)
    await ref.set({
      email: `${u.uid.slice(0, 8).toLowerCase()}@drive.test`,
      refresh: seal('fake:seed'),
      scope: DRIVE_SCOPE,
      fake: true,
      connectedAt: now,
      updatedAt: now,
      brokenAt: null,
    });
}

/** A connected fake Drive for `owner` and a board folder in it. */
export async function fakeDriveBoard(
  owner: TestUser,
  name: string,
): Promise<NonNullable<Board['storage']>> {
  await connectFakeDrive(owner);
  const drive = fakeDrive(owner.uid);
  const folder = await drive.createFolder(null, `Board ${name}`);
  const tickets = await drive.createFolder(folder.id, 'tickets');
  return {
    kind: 'drive',
    uid: owner.uid,
    folderId: folder.id,
    folderName: folder.name,
    email: null,
    ticketsFolderId: tickets.id,
  };
}

/** Add someone to an existing board after the fact. */
export async function addMember(boardId: string, u: TestUser, role: BoardRole): Promise<void> {
  const ref = db().doc(paths.board(boardId));
  const b = (await ref.get()).data() as Board;
  b.access[u.uid] = role;
  b.readerUids = [...new Set([...b.readerUids, u.uid])];
  if (role === 'admin' || role === 'editor') b.editorUids = [...new Set([...b.editorUids, u.uid])];
  await ref.set(b);
  await db()
    .doc(paths.member(boardId, u.uid))
    .set({
      kind: 'user',
      uid: u.uid,
      role,
      stageGrant: null,
      name: u.displayName,
      email: u.email,
      avatarPath: null,
      invitedBy: null,
      joinedAt: Date.now(),
    } satisfies BoardMember);
}

/** A few named users at once. */
export async function people<K extends string>(...names: K[]): Promise<Record<K, TestUser>> {
  const out = {} as Record<K, TestUser>;
  await Promise.all(names.map(async (n) => (out[n] = await createUser({ name: n }))));
  return out;
}

export async function getDocData<T>(path: string): Promise<T | undefined> {
  const s = await db().doc(path).get();
  return s.exists ? (s.data() as T) : undefined;
}

export async function listDocs<T>(path: string): Promise<(T & { id: string })[]> {
  const s = await db().collection(path).get();
  return s.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
}

/** A paragraph doc of mixed text / mention / ticketRef nodes. */
export function doc(
  ...parts: (string | { uid: string } | { ticketId: string; key?: string })[]
): RichTextDocInput {
  return {
    type: 'doc' as const,
    content: [
      {
        type: 'paragraph',
        content: parts.map((p) =>
          typeof p === 'string'
            ? { type: 'text', text: p }
            : 'uid' in p
              ? { type: 'mention', attrs: { uid: p.uid } }
              : {
                  type: 'ticketRef',
                  attrs: { ticketId: p.ticketId, ...(p.key ? { key: p.key } : {}) },
                },
        ),
      },
    ],
  };
}

// ─── bucket.html §J: ticket attachments live in a bucket ────────────────────

export interface AttachBucketOptions {
  /** The grant to the board (default 'write'). */
  access?: 'read' | 'write';
  /** Make it the board's attachBucket (default: when the grant is 'write'). */
  setDefault?: boolean;
  template?: string;
}

/**
 * A bucket owned by `owner`, granted to the board, and (by default) set as the
 * board's attachment bucket — seeded straight into Firestore, like seedBoard.
 */
export async function seedAttachBucket(
  boardId: string,
  owner: TestUser,
  o: AttachBucketOptions = {},
): Promise<string> {
  const bucketId = uniq('mem_');
  const access = o.access ?? 'write';
  const bucket: Bucket = {
    name: 'Attachments',
    description: '',
    icon: null,
    ownerUid: owner.uid,
    access: { [owner.uid]: 'owner' },
    memberUids: [owner.uid],
    boards: { [boardId]: access },
    artifacts: {},
    boardIds: [boardId],
    stats: { files: 0, folders: 0, bytes: 0 },
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db().doc(paths.bucket(bucketId)).set(bucket);
  if (o.setDefault ?? access === 'write')
    await db()
      .doc(paths.board(boardId))
      .update({
        attachBucket: { bucketId, template: o.template ?? DEFAULT_ATTACH_TEMPLATE },
      });
  return bucketId;
}

/** Bytes the app uploaded into a bucket (the in-memory Storage port, or the real one). */
export async function putBucketObject(
  files: Pick<StorageFiles, 'write'>,
  bucketId: string,
  name = 'shot.png',
  bytes: Uint8Array = new Uint8Array([1, 2, 3, 4]),
  contentType = 'image/png',
): Promise<{ storagePath: string; fileId: string }> {
  const fileId = uniq('f_');
  const storagePath = bucketStoragePath(bucketId, fileId, name);
  await files.write(storagePath, bytes, contentType);
  return { storagePath, fileId };
}
