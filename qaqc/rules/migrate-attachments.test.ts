/**
 * scripts/lib/attachments-to-memory.mjs against the emulators (firestore +
 * storage): seed boards and tickets whose files live under boards/…, run the
 * migration dry and then for real, and check the memory, its nodes, the
 * copied objects and every rewritten reference. Then run it again: nothing
 * may duplicate.
 *
 * Not a rules suite — it lives here because this project is the one that runs
 * with the emulators up (`pnpm --filter @tm/qaqc test:rules`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import {
  getBytes,
  getMetadata,
  ref as sref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage';
import * as S from '@tm/shared';
import { nodeIdFor, type Summary } from '../../scripts/lib/attachments-to-memory.mjs';
import { PROJECT_ID, boardDoc, fs, makeEnv, st } from './_env.js';

const here = dirname(fileURLToPath(import.meta.url));

const OWNER = 'u_mig_owner';
const AT = Date.UTC(2026, 9, 5, 21, 19, 46);
const T = '20261005-211946';
// The bucket @firebase/rules-unit-testing uses: gs://<projectId>.
const BUCKET = PROJECT_ID;

const B1 = 'board_mig1';
const B2 = 'board_mig2'; // archived
const p = (b: string, t: string, id: string, name: string) =>
  `boards/${b}/tickets/${t}/${id}/${encodeURIComponent(name)}`;
const P1 = p(B1, 'tkt_a', 'att_1', 'logo.png');
const P2 = p(B1, 'tkt_a', 'att_2', 'logo.png'); // same name, same second → (2)
const P3 = p(B1, 'tkt_a', 'att_3', 'gone.txt'); // no object
const P4 = p(B1, 'tkt_a', 'att_4', 'old.txt'); // tombstoned
const P5 = p(B2, 'tkt_b', 'att_5', 'report.pdf');
const THUMB = `boards/${B1}/tickets/tkt_a/att_1/thumb_400.webp`;
const PRE = 'memories/memPREEXIST1/nodes/nodePREEXIST1';

const bytesOf = (s: string) => Buffer.from(s, 'utf8');

function fileRow(
  id: string,
  path: string,
  name: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    path,
    name,
    mime: name.endsWith('.png')
      ? 'image/png'
      : name.endsWith('.pdf')
        ? 'application/pdf'
        : 'text/plain',
    size: 5,
    uploadedBy: OWNER,
    source: 'message',
    messageId: 'msg_1',
    createdAt: AT,
    deletedAt: null,
    ...over,
  };
}
const attOf = (r: ReturnType<typeof fileRow>) => {
  const { source: _s, messageId: _m, createdAt: _c, deletedAt: _d, ...a } = r;
  return a;
};

const R1 = fileRow('att_1', P1, 'logo.png', { thumbPath: THUMB, width: 64, height: 32 });
const R2 = fileRow('att_2', P2, 'logo.png', { source: 'description', messageId: null });
const R3 = fileRow('att_3', P3, 'gone.txt');
const R4 = fileRow('att_4', P4, 'old.txt', { deletedAt: AT + 1, messageId: 'msg_dead' });
const R6 = fileRow('att_6', PRE, 'already.md', {
  memory: { memoryId: 'memPREEXIST1', nodeId: 'nodePREEXIST1' },
});
const R5 = fileRow('att_5', P5, 'report.pdf', { messageId: 'msg_b' });

const TICKET_A = {
  key: 'MIG-1',
  createdAt: 1,
  files: [R1, R2, R3, R4, R6],
  fileIds: ['att_1', 'att_2', 'att_3', 'att_6'],
  recentMessages: [
    {
      id: 'msg_1',
      kind: 'comment',
      attachments: [attOf(R1), attOf(R3)],
      deletedAt: null,
      createdAt: AT,
    },
    { id: 'msg_dead', kind: 'comment', attachments: [], deletedAt: AT + 1, createdAt: AT },
  ],
  pageCount: 1,
};
// The description file shows up in an OLD message too, spilled to a data page.
const PAGE_A = {
  page: 0,
  messages: [
    { id: 'msg_0', kind: 'comment', attachments: [attOf(R2)], deletedAt: null, createdAt: 2 },
  ],
  activity: [],
  from: 2,
  to: 2,
  createdAt: 2,
};
const TICKET_B = {
  key: 'OLD-1',
  createdAt: 1,
  files: [R5],
  fileIds: ['att_5'],
  recentMessages: [
    { id: 'msg_b', kind: 'comment', attachments: [attOf(R5)], deletedAt: null, createdAt: AT },
  ],
  pageCount: 0,
};

let env: RulesTestEnvironment;
const logs: string[] = [];

/** The migration, in a plain Node child (see _migrate-runner.ts for why). */
function run(apply: boolean): Summary {
  const r = spawnSync(
    process.execPath,
    [
      '--conditions=@tm/source',
      '--import',
      'tsx',
      resolve(here, '_migrate-runner.ts'),
      JSON.stringify({ projectId: PROJECT_ID, bucket: BUCKET, ownerUid: OWNER, apply, now: 1_000 }),
    ],
    { cwd: resolve(here, '..'), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  const lines = (r.stdout ?? '').split('\n');
  logs.push(...lines);
  const last = lines.find((l) => l.startsWith('SUMMARY '));
  if (r.status !== 0 || !last)
    throw new Error(`migration failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(last.slice('SUMMARY '.length)) as Summary;
}

/** Firestore / Storage with the rules off — the seeding and the checking. */
async function admin<T>(fn: (db: Firestore, storage: FirebaseStorage) => Promise<T>): Promise<T> {
  let out!: T;
  await env.withSecurityRulesDisabled(async (ctx) => {
    out = await fn(fs(ctx), st(ctx));
  });
  return out;
}
const read = (path: string) => admin(async (db) => (await getDoc(doc(db, path))).data());
const list = (path: string) =>
  admin(async (db) =>
    (await getDocs(collection(db, path))).docs.map(
      (d) => ({ id: d.id, ...d.data() }) as DocumentData & { id: string },
    ),
  );
const object = (path: string) =>
  admin(async (_db, storage) => {
    try {
      const r = sref(storage, path);
      const [bytes, md] = await Promise.all([getBytes(r), getMetadata(r)]);
      return { text: Buffer.from(bytes).toString('utf8'), md };
    } catch {
      return null;
    }
  });

const seedTickets = () =>
  admin(async (db) => {
    await setDoc(doc(db, `boards/${B1}/tickets/tkt_a`), TICKET_A);
    await setDoc(doc(db, `boards/${B1}/tickets/tkt_a/data/000`), PAGE_A);
    await setDoc(doc(db, `boards/${B2}/tickets/tkt_b`), TICKET_B);
  });

beforeAll(async () => {
  env = await makeEnv({ firestore: true, storage: true });
  await env.clearFirestore();
  await env.clearStorage();
  await admin(async (db, storage) => {
    await setDoc(doc(db, `boards/${B1}`), boardDoc({ [OWNER]: 'admin' }, 'Migrate', 'MIG'));
    await setDoc(doc(db, `boards/${B2}`), {
      ...boardDoc({ [OWNER]: 'admin' }, 'Old', 'OLD'),
      archivedAt: 5,
    });
    for (const [path, body, contentType] of [
      [P1, 'PNG!1', 'image/png'],
      [P2, 'PNG!2', 'image/png'],
      [P4, 'dead.', 'text/plain'],
      [P5, '%PDF-', 'application/pdf'],
      [THUMB, 'thumb', 'image/webp'],
    ] as const)
      await uploadBytes(sref(storage, path), bytesOf(body), {
        contentType,
        customMetadata: { boardId: B1 },
      });
  });
  await seedTickets();
});

afterAll(async () => {
  await env?.cleanup();
});

describe('attachments → memory migration (emulators)', () => {
  let first: Summary;
  let memoryId = '';

  it('a dry run plans and writes nothing', async () => {
    const dry = run(false);
    expect(dry.stopped).toBeUndefined();
    expect(dry).toMatchObject({
      memoryId: null,
      boards: 2,
      archivedBoards: 1,
      tickets: 2,
      ticketsToChange: 2,
      filesToMove: 3,
      renamed: 1,
      foldersToCreate: 5, // boards, boards/MIG, boards/MIG/MIG-1, boards/OLD, boards/OLD/OLD-1
      refsToRewrite: 6, // rows R1 R2 R5 + msg_1, msg_0 (data page), msg_b
      bytes: 15,
    });
    expect(dry.skipped.map((s) => s.rowId)).toEqual(['att_3']);
    expect(await list('memories')).toHaveLength(0);
    expect((await read(`boards/${B1}`))?.attachMemory).toBeUndefined();
    expect(logs.some((l) => l.includes(`${P1}  →  ticket:/boards/MIG/MIG-1/${T}_logo.png`))).toBe(
      true,
    );
  });

  it('--apply makes the memory, grants every board, moves the files and rewrites every reference', async () => {
    first = run(true);
    expect(first.applied).toMatchObject({
      tickets: 2,
      files: 3,
      folders: 5,
      copied: 3,
      failed: [],
    });
    memoryId = first.memoryId!;
    expect(S.MemoryIdSchema.safeParse(memoryId).success).toBe(true);

    const mem = (await read(`memories/${memoryId}`))!;
    expect(S.MemorySchema.safeParse(mem).success).toBe(true);
    expect(mem).toMatchObject({
      name: 'ticket',
      description: 'Ticket attachments, moved from boards',
      ownerUid: OWNER,
      access: { [OWNER]: 'owner' },
      memberUids: [OWNER],
      boards: { [B1]: 'write', [B2]: 'write' },
      boardIds: [B1, B2],
      stats: { files: 3, folders: 5, bytes: 15 },
    });
    for (const [b, key] of [
      [B1, 'MIG'],
      [B2, 'OLD'],
    ])
      expect((await read(`boards/${b}`))?.attachMemory).toEqual({
        memoryId,
        template: `boards/${key}/<ticketId>/<time>_<filename>`,
      });

    const nodes = await list(`memories/${memoryId}/nodes`);
    expect(nodes).toHaveLength(8);
    for (const { id: _id, ...n } of nodes)
      expect(S.MemoryNodeSchema.safeParse(n).success).toBe(true);
    const byPath = new Map(nodes.map((n) => [n.path as string, n]));
    const n1 = byPath.get(`boards/MIG/MIG-1/${T}_logo.png`)!;
    const n2 = byPath.get(`boards/MIG/MIG-1/${T}_logo (2).png`)!;
    const n5 = byPath.get(`boards/OLD/OLD-1/${T}_report.pdf`)!;
    expect(n1.id).toBe(nodeIdFor(P1));
    expect(n2.id).toBe(nodeIdFor(P2));
    expect(n1.parentId).toBe(byPath.get('boards/MIG/MIG-1')!.id);
    expect(byPath.get('boards/MIG')!.parentId).toBe(byPath.get('boards')!.id);
    expect(byPath.get('boards')!.parentId).toBeNull();
    expect(n1).toMatchObject({
      kind: 'file',
      createdAt: AT,
      createdBy: OWNER,
      file: { mime: 'image/png', size: 5, width: 64, height: 32 },
    });

    // The bytes were copied with their type and metadata; the old object is still there.
    expect(n1.file.storagePath).toBe(
      `memories/${memoryId}/${n1.file.fileId}/${encodeURIComponent(`${T}_logo.png`)}`,
    );
    const copy = (await object(n1.file.storagePath))!;
    expect(copy.text).toBe('PNG!1');
    expect(copy.md.contentType).toBe('image/png');
    expect(copy.md.customMetadata).toMatchObject({ boardId: B1, migratedFrom: P1 });
    expect((await object(P1))?.text).toBe('PNG!1');
    expect((await object(n5.file.storagePath))?.text).toBe('%PDF-');

    // References.
    const ref = (n: { id: string }) => ({
      path: S.memoryRefPath(memoryId, n.id),
      memory: { memoryId, nodeId: n.id },
    });
    const a = (await read(`boards/${B1}/tickets/tkt_a`))!;
    const [f1, f2, f3, f4, f6] = a.files;
    const { thumbPath: _t, ...r1 } = R1;
    expect(f1).toEqual({ ...r1, ...ref(n1) });
    expect(f2).toEqual({ ...R2, ...ref(n2) });
    expect(f3).toEqual(R3); // object missing: left alone
    expect(f4).toEqual(R4); // tombstone: left alone
    expect(f6).toEqual(R6); // already a memory reference
    expect(a.fileIds).toEqual(TICKET_A.fileIds);
    expect(a.migrations?.attachmentsToMemory).toBe(1_000);
    const { thumbPath: _t2, ...a1 } = attOf(R1);
    expect(a.recentMessages[0].attachments).toEqual([{ ...a1, ...ref(n1) }, attOf(R3)]);
    expect(a.recentMessages[1]).toEqual(TICKET_A.recentMessages[1]);
    const page = (await read(`boards/${B1}/tickets/tkt_a/data/000`))!;
    expect(page.messages[0].attachments).toEqual([{ ...attOf(R2), ...ref(n2) }]);
    for (const f of a.files) expect(S.TicketFileSchema.safeParse(f).success).toBe(true);

    const b = (await read(`boards/${B2}/tickets/tkt_b`))!;
    expect(b.files[0]).toEqual({ ...R5, ...ref(n5) });
    expect(b.recentMessages[0].attachments[0]).toEqual({ ...attOf(R5), ...ref(n5) });
  });

  it('a second run changes nothing', async () => {
    const before = (await read(`memories/${memoryId}`))!;
    const again = run(true);
    expect(again.memoryId).toBe(memoryId);
    expect(again).toMatchObject({
      filesToMove: 0,
      filesReused: 0,
      ticketsToChange: 0,
      grantsToWrite: 0,
      attachMemoryToWrite: 0,
    });
    expect(await list('memories')).toHaveLength(1);
    expect(await list(`memories/${memoryId}/nodes`)).toHaveLength(8);
    expect((await read(`memories/${memoryId}`))?.stats).toEqual(before.stats);
  });

  it('a ticket put back as it was reuses the nodes (no copy, no new node, counters unchanged)', async () => {
    const stats = (await read(`memories/${memoryId}`))?.stats;
    // Someone renamed a migrated node; then the ticket documents are restored.
    await admin((db) =>
      updateDoc(doc(db, `memories/${memoryId}/nodes/${nodeIdFor(P1)}`), {
        path: 'boards/MIG/MIG-1/renamed.png',
        name: 'renamed.png',
      }),
    );
    await seedTickets();
    const res = run(true);
    expect(res).toMatchObject({ filesToMove: 0, filesReused: 3, ticketsToChange: 2 });
    expect(res.applied).toMatchObject({ files: 0, folders: 0, copied: 0, failed: [] });
    expect(await list(`memories/${memoryId}/nodes`)).toHaveLength(8);
    expect((await read(`memories/${memoryId}`))?.stats).toEqual(stats);
    const a = (await read(`boards/${B1}/tickets/tkt_a`))!;
    expect(a.files[0].memory).toEqual({ memoryId, nodeId: nodeIdFor(P1) });
    expect(a.recentMessages[0].attachments[0].memory).toEqual({ memoryId, nodeId: nodeIdFor(P1) });
  });

  it('stops before writing when there are more boards than a memory may be granted to', async () => {
    await admin(async (db) => {
      const batch = writeBatch(db);
      for (let i = 0; i < S.MEMORY_GRANTS_MAX; i++)
        batch.set(doc(db, `boards/board_x${i}`), boardDoc({ [OWNER]: 'admin' }, `X${i}`, `X${i}`));
      await batch.commit();
    });
    const before = await read(`memories/${memoryId}`);
    const res = run(true);
    expect(res.stopped).toMatch(new RegExp(`at most ${S.MEMORY_GRANTS_MAX}`));
    expect(res.grants).toBe(S.MEMORY_GRANTS_MAX + 2);
    expect(await read(`memories/${memoryId}`)).toEqual(before);
    expect((await read('boards/board_x0'))?.attachMemory).toBeUndefined();
  });
});
