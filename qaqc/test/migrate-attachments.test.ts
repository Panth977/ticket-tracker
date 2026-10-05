/**
 * scripts/lib/attachments-to-memory.mjs — the pure planning half of the
 * attachments → memory migration (the emulator half is
 * rules/migrate-attachments.test.ts).
 */
import { describe, expect, it } from 'vitest';
import * as S from '@tm/shared';
import {
  allocatePath,
  boardTemplate,
  classifyRow,
  fileIdFor,
  fileNodeFor,
  foldersToCreate,
  nodeIdFor,
  orphanMessageAttachments,
  planTicket,
  rewriteTicket,
  rewriteMessages,
  targetPathFor,
  type PlanState,
} from '../../scripts/lib/attachments-to-memory.mjs';

const AT = Date.UTC(2026, 9, 5, 21, 19, 46); // → 20261005-211946
const att = (id: string, name = 'logo.png') =>
  `boards/b1/tickets/t1/${id}/${encodeURIComponent(name)}`;

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    path: att(id),
    name: 'logo.png',
    mime: 'image/png',
    size: 100,
    uploadedBy: 'u_owner',
    source: 'message',
    messageId: 'm1',
    createdAt: AT,
    deletedAt: null,
    ...over,
  };
}

function freshState(objects: string[] = []): PlanState {
  return {
    taken: new Map(),
    nodesById: new Map(),
    objects: new Map(
      objects.map((p) => [p, { exists: true, size: 123, contentType: 'image/png' }]),
    ),
  };
}

describe('paths', () => {
  it('fills the board template with the ticket key, UTC time and sanitized name', () => {
    expect(targetPathFor(S, 'ENG', 'ENG-42', row('a1'))).toBe(
      'boards/ENG/ENG-42/20261005-211946_logo.png',
    );
    expect(targetPathFor(S, 'ENG', 'ENG-42', row('a1', { name: 'a/b\\c.txt' }))).toBe(
      'boards/ENG/ENG-42/20261005-211946_a_b_c.txt',
    );
  });

  it('the board template is a valid attach template', () => {
    expect(S.attachTemplateProblem(boardTemplate('ENG'))).toBeNull();
    expect(
      S.BoardAttachMemorySchema.safeParse({
        memoryId: 'abcdefABCDEF0123',
        template: boardTemplate('ENG'),
      }).success,
    ).toBe(true);
  });

  it('numbers a clash before the extension, and refuses a file where a folder must be', () => {
    const taken = new Map<string, string>([
      ['x/a.png', 'file'],
      ['x/a (2).png', 'file'],
    ]);
    expect(allocatePath(S, 'x/a.png', taken)).toEqual({ path: 'x/a (3).png', n: 3 });
    expect(allocatePath(S, 'x/b.png', taken)).toEqual({ path: 'x/b.png', n: 1 });
    expect(allocatePath(S, 'x/a.png/c', taken).error).toMatch(/is a file/);
    // A folder path is taken too: a file never lands on it.
    expect(allocatePath(S, 'x', new Map([['x', 'folder']]))).toEqual({ path: 'x (2)', n: 2 });
  });

  it('derived ids are valid node / file ids, stable, and distinct', () => {
    const p = att('a1');
    expect(S.MemoryNodeIdSchema.safeParse(nodeIdFor(p)).success).toBe(true);
    expect(S.MemoryFileIdSchema.safeParse(fileIdFor(p)).success).toBe(true);
    expect(nodeIdFor(p)).toBe(nodeIdFor(p));
    expect(nodeIdFor(p)).not.toBe(fileIdFor(p));
    expect(nodeIdFor(p)).not.toBe(nodeIdFor(att('a2')));
  });

  it('folders to create, root first, skipping existing ones', () => {
    expect(
      foldersToCreate(
        ['boards/ENG/ENG-1/a', 'boards/ENG/ENG-2/b'],
        new Map([['boards', 'folder']]),
      ),
    ).toEqual(['boards/ENG', 'boards/ENG/ENG-1', 'boards/ENG/ENG-2']);
  });
});

describe('classifyRow', () => {
  it('memory refs, tombstones, foreign paths, board attachments', () => {
    expect(classifyRow(S, row('a', { memory: { memoryId: 'mmmmmm', nodeId: 'nnnnnn' } }))).toBe(
      'memory',
    );
    expect(classifyRow(S, row('a', { path: 'memories/mmmmmm/nodes/nnnnnn' }))).toBe('memory');
    expect(classifyRow(S, row('a', { deletedAt: 5 }))).toBe('deleted');
    expect(classifyRow(S, row('a', { path: 'users/u/avatar/1.webp' }))).toBe('foreign');
    expect(classifyRow(S, row('a', { path: 'boards/b1/tickets/t1/a/thumb_400.webp' }))).toBe(
      'foreign',
    );
    expect(classifyRow(S, row('a'))).toBe('move');
  });
});

describe('planTicket', () => {
  const board = { key: 'ENG' };

  it('plans each live board attachment; same time + name → numbered', () => {
    const state = freshState([att('a1'), att('a2')]);
    const ticket = {
      key: 'ENG-1',
      files: [row('a1'), row('a2', { source: 'description', messageId: null })],
    };
    const { moves, skipped } = planTicket(S, state, board, ticket);
    expect(skipped).toEqual([]);
    expect(moves.map((m) => m.path)).toEqual([
      'boards/ENG/ENG-1/20261005-211946_logo.png',
      'boards/ENG/ENG-1/20261005-211946_logo (2).png',
    ]);
    expect(moves[1]!.renamed).toBe(true);
    expect(moves[0]!.size).toBe(123); // the object's real size
    expect(state.taken.get('boards/ENG')).toBe('folder');
  });

  it('a clash with an existing node or another ticket in the same run is numbered', () => {
    const state = freshState([att('a1'), att('b1')]);
    state.taken.set('boards/ENG/ENG-1/20261005-211946_logo.png', 'file');
    const one = planTicket(S, state, board, { key: 'ENG-1', files: [row('a1')] });
    expect(one.moves[0]!.path).toBe('boards/ENG/ENG-1/20261005-211946_logo (2).png');
  });

  it('skips tombstones and memory rows silently, reports missing objects and foreign paths', () => {
    const state = freshState([att('a1')]);
    const { moves, skipped } = planTicket(S, state, board, {
      key: 'ENG-1',
      files: [
        row('a1'),
        row('gone'),
        row('dead', { deletedAt: 9 }),
        row('mem', {
          path: 'memories/mmmmmm/nodes/nnnnnn',
          memory: { memoryId: 'mmmmmm', nodeId: 'nnnnnn' },
        }),
        row('odd', { path: 'somewhere/else.png' }),
      ],
    });
    expect(moves.map((m) => m.rowIds)).toEqual([['a1']]);
    expect(skipped.map((s) => [s.rowId, s.reason])).toEqual([
      ['gone', 'Storage object missing'],
      ['odd', 'not a board attachment path'],
    ]);
  });

  it('two rows with the SAME old path share one node', () => {
    const state = freshState([att('a1')]);
    const { moves } = planTicket(S, state, board, {
      key: 'ENG-1',
      files: [row('a1'), row('a1copy', { path: att('a1') })],
    });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.rowIds).toEqual(['a1', 'a1copy']);
  });

  it('reuses a node an earlier run made (by its derived id), even if moved, without a Storage check', () => {
    const state = freshState([]); // object facts unknown: not needed
    state.nodesById.set(nodeIdFor(att('a1')), { path: 'elsewhere/logo.png' });
    const { moves, skipped } = planTicket(S, state, board, { key: 'ENG-1', files: [row('a1')] });
    expect(skipped).toEqual([]);
    expect(moves[0]).toMatchObject({
      reused: true,
      path: 'elsewhere/logo.png',
      nodeId: nodeIdFor(att('a1')),
    });
  });
});

describe('nodes and references', () => {
  const MEM = 'memABCDEF012345';
  const state = freshState([att('a1')]);
  const [move] = planTicket(
    S,
    state,
    { key: 'ENG' },
    {
      key: 'ENG-1',
      files: [row('a1', { width: 640, height: 480 })],
    },
  ).moves;

  it('the file node has the MemoryNode shape and the backend storage naming', () => {
    const node = fileNodeFor(S, MEM, move!, 'parent0001');
    expect(S.MemoryNodeSchema.safeParse(node).success).toBe(true);
    expect(node).toMatchObject({
      kind: 'file',
      parentId: 'parent0001',
      name: '20261005-211946_logo.png',
      createdAt: AT,
      createdBy: 'u_owner',
      file: {
        fileId: fileIdFor(att('a1')),
        storagePath: `memories/${MEM}/${fileIdFor(att('a1'))}/20261005-211946_logo.png`,
        mime: 'image/png',
        size: 123,
        width: 640,
        height: 480,
      },
    });
    const odd = fileNodeFor(S, MEM, { ...move!, path: 'x/a b#.png', width: undefined }, null);
    expect(odd.file.storagePath).toBe(`memories/${MEM}/${move!.fileId}/a%20b%23.png`);
    expect(odd.file).not.toHaveProperty('width');
  });

  it('rewrites live rows and message attachments, drops thumbPath, keeps the rest; tombstones untouched', () => {
    const refs = new Map([[att('a1'), move!.nodeId]]);
    const live = row('a1', {
      thumbPath: 'boards/b1/tickets/t1/a1/thumb_400.webp',
      width: 640,
      height: 480,
    });
    const dead = row('a1dead', { path: att('a1'), deletedAt: 7 });
    const other = row('zz', { path: att('zz') });
    const ticket = {
      files: [live, dead, other],
      recentMessages: [
        { id: 'm1', attachments: [{ ...live }] },
        { id: 'm2', attachments: [] },
      ],
    };
    const out = rewriteTicket(S, ticket, refs, MEM);
    expect(out.changed).toBe(2);
    const f = out.files[0];
    expect(f).toEqual({
      ...live,
      thumbPath: undefined,
      path: S.memoryRefPath(MEM, move!.nodeId),
      memory: { memoryId: MEM, nodeId: move!.nodeId },
    } as never);
    expect(f).not.toHaveProperty('thumbPath');
    expect(S.TicketFileSchema.safeParse(f).success).toBe(true);
    expect(out.files[1]).toBe(dead);
    expect(out.files[2]).toBe(other);
    expect(out.recentMessages[0].attachments[0].path).toBe(S.memoryRefPath(MEM, move!.nodeId));
    expect(out.recentMessages[1]).toBe(ticket.recentMessages[1]);
    // Idempotent: a rewritten attachment is left as it is.
    expect(
      rewriteTicket(S, { files: out.files, recentMessages: out.recentMessages }, refs, MEM).changed,
    ).toBe(0);
  });

  it('data page messages, and orphan attachments are reported', () => {
    const refs = new Map([[att('a1'), move!.nodeId]]);
    const page = { messages: [{ id: 'old', attachments: [row('a1')] }] };
    expect(rewriteMessages(S, page.messages, refs, MEM).changed).toBe(1);
    expect(
      orphanMessageAttachments(
        S,
        {
          files: [row('a1')],
          recentMessages: [{ id: 'm9', attachments: [row('q', { path: att('q') })] }],
        },
        [page],
      ),
    ).toEqual([{ messageId: 'm9', path: att('q') }]);
  });
});
