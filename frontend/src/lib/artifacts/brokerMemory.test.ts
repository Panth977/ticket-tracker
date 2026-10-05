/**
 * memory.html §H — the broker's mem.* ops: the grant is the ceiling, the
 * viewer's reach the floor, an unreadable grant counts as 'read', and every
 * op becomes the viewer's own memory command with a normalized path.
 */
import { describe, expect, it } from 'vitest';
import type { MemoryGrant, MemoryNodeOut, MemoryOut } from '@tm/shared';
import { blobToBase64, createMemoryOps, toDriverMemory, type MemoryBackend } from './brokerMemory';

const A = 'artAAAAAA1';
const out = (id: string, reach: MemoryOut['reach'], archived = false): MemoryOut => ({
  id,
  name: `M ${id}`,
  description: null,
  icon: null,
  indicator: { kind: 'emoji', emoji: '🧠' },
  reach,
  archived,
  stats: { files: 2, folders: 1, bytes: 30 },
  updatedAt: 1,
});
const node = (path: string, kind: 'file' | 'folder' = 'file'): MemoryNodeOut => ({
  id: `n_${path.replace(/\W/g, '')}`,
  kind,
  parentId: null,
  name: path.split('/').pop()!,
  path,
  file: kind === 'file' ? { fileId: 'file01', mime: 'text/plain', size: 5 } : null,
  updatedAt: 2,
});

class Fail extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function setup(rows: { memory: MemoryOut; grant: MemoryGrant | null }[]) {
  const calls: [string, ...unknown[]][] = [];
  let lists = 0;
  const backend: MemoryBackend = {
    async list() {
      lists++;
      return rows;
    },
    async tree(m, p) {
      calls.push(['tree', m, p]);
      return [node('docs', 'folder'), node('docs/a.md')];
    },
    async read(m, p, asText) {
      calls.push(['read', m, p, asText]);
      return { text: asText ? 'hello' : null, truncated: false, url: 'https://u/x', expiresAt: 9 };
    },
    async write(m, p, content, mime) {
      calls.push(['write', m, p, content, mime]);
    },
    async mkdir(m, p) {
      calls.push(['mkdir', m, p]);
    },
    async remove(m, p) {
      calls.push(['remove', m, p]);
    },
  };
  const ops = createMemoryOps({
    artifactId: A,
    backend,
    fail: (code, message) => {
      throw new Fail(code, message);
    },
    now: () => 0,
  });
  return { ops, calls, lists: () => lists };
}

describe('toDriverMemory', () => {
  it('ceiling and floor', () => {
    expect(toDriverMemory(A, out('m1', 'manage'), 'write')!.access).toBe('write');
    expect(toDriverMemory(A, out('m1', 'manage'), 'read')!.access).toBe('read');
    expect(toDriverMemory(A, out('m1', 'read'), 'write')!.access).toBe('read');
    // An unreadable grant is never guessed upward.
    expect(toDriverMemory(A, out('m1', 'write'), null)!.access).toBe('read');
    expect(toDriverMemory(A, out('m1', 'write', true), 'write')!.access).toBe('read');
  });
});

describe('mem.* ops', () => {
  const rows = [
    { memory: out('mw', 'write'), grant: 'write' as const },
    { memory: out('mr', 'manage'), grant: 'read' as const },
  ];

  it('list: the granted memories with the page’s access; cached between ops', async () => {
    const t = setup(rows);
    expect(await t.ops.run('mem.list', {})).toEqual([
      expect.objectContaining({ id: 'mw', access: 'write', files: 2, bytes: 30 }),
      expect.objectContaining({ id: 'mr', access: 'read' }),
    ]);
    await t.ops.run('mem.tree', { memory: 'mw' });
    expect(t.lists()).toBe(1);
  });

  it('reads: tree with a normalized path, text, url', async () => {
    const t = setup(rows);
    const tree = (await t.ops.run('mem.tree', { memory: 'mr', path: '/docs/' })) as unknown[];
    expect(tree[1]).toEqual({
      id: 'n_docsamd',
      kind: 'file',
      path: 'docs/a.md',
      name: 'a.md',
      mime: 'text/plain',
      size: 5,
      updatedAt: 2,
    });
    expect(await t.ops.run('mem.read', { memory: 'mr', path: 'docs//a.md' })).toEqual({
      text: 'hello',
      truncated: false,
    });
    expect(await t.ops.run('mem.url', { memory: 'mr', path: 'docs/a.md' })).toEqual({
      url: 'https://u/x',
      expiresAt: 9,
    });
    expect(t.calls).toEqual([
      ['tree', 'mr', 'docs'],
      ['read', 'mr', 'docs/a.md', true],
      ['read', 'mr', 'docs/a.md', false],
    ]);
  });

  it('writes need a write access; text and Blobs become the viewer’s commands', async () => {
    const t = setup(rows);
    await expect(
      t.ops.run('mem.write', { memory: 'mr', path: 'x.md', text: 'x' }),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(t.ops.run('mem.remove', { memory: 'mr', path: 'docs' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await t.ops.run('mem.write', { memory: 'mw', path: 'notes/a.md', text: '# A' });
    await t.ops.run('mem.write', {
      memory: 'mw',
      path: 'b.bin',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/x-test' }),
    });
    await t.ops.run('mem.mkdir', { memory: 'mw', path: 'a/b' });
    await t.ops.run('mem.remove', { memory: 'mw', path: 'a' });
    expect(t.calls).toEqual([
      ['write', 'mw', 'notes/a.md', { text: '# A' }, null],
      ['write', 'mw', 'b.bin', { content_base64: 'AQID' }, 'application/x-test'],
      ['mkdir', 'mw', 'a/b'],
      ['remove', 'mw', 'a'],
    ]);
  });

  it('refuses a memory that is not granted, bad paths and oversized writes', async () => {
    const t = setup(rows);
    await expect(t.ops.run('mem.tree', { memory: 'other' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(t.ops.run('mem.read', { memory: 'mw', path: 'a/../b' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(t.ops.run('mem.remove', { memory: 'mw', path: '' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(
      t.ops.run('mem.write', { memory: 'mw', path: 'big', text: 'x'.repeat(10 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: 'quota' });
    expect(t.calls).toEqual([]);
  });
});

describe('blobToBase64', () => {
  it('encodes bytes beyond one chunk', async () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    const b64 = await blobToBase64(new Blob([bytes]));
    expect(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).toEqual(bytes);
  });
});
