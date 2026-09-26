/** api-core pieces that need no emulator. */
import { describe, expect, it } from 'vitest';
import { memoryQueue, memorySearch, seqIds, taskId } from '../../src/adapters/index.js';
import { bearer } from '../../src/middleware/user.js';
import { defineTask } from '../../src/runtime/functions.js';
import { toAppError } from '../../src/runtime/runner.js';
import { AppError } from '@tm/shared';
import { z } from 'zod';

describe('bearer()', () => {
  it('parses the Authorization header', () => {
    expect(bearer('Bearer abc.def')).toBe('abc.def');
    expect(bearer('bearer x')).toBe('x');
    expect(bearer('Basic x')).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });
});

describe('taskId()', () => {
  it('keeps safe names, maps others stably', () => {
    expect(taskId('abc_DEF-1')).toBe('abc_DEF-1');
    const a = taskId('uid:group:123');
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(taskId('uid:group:123')).toBe(a);
    expect(taskId('uid_group_123')).not.toBe(a);
  });
});

describe('memoryQueue', () => {
  it('dedupes by name and drains through registered handlers', async () => {
    const q = memoryQueue();
    const seen: string[] = [];
    defineTask('export', async (d) => {
      seen.push(d.jobId);
      if (d.jobId === 'j1') await q.enqueue('export', { ...d, jobId: 'j2' });
    });
    const p = { jobId: 'j1', uid: 'u' };
    await q.enqueue('export', p, { name: 'x' });
    await q.enqueue('export', p, { name: 'x' });
    await q.enqueue('boardDelete', { boardId: 'a', actor: 'u' }); // no handler: stays pending
    expect(await q.drain()).toBe(2);
    expect(seen).toEqual(['j1', 'j2']);
    expect(q.pending().map((t) => t.queue)).toEqual(['boardDelete']);
    expect(() => defineTask('export', async () => {})).toThrow(/twice/);
  });
});

describe('memorySearch', () => {
  it('scopes by board and matches key/title/text', async () => {
    const s = memorySearch();
    const base = {
      stageCategory: 'todo' as const,
      assigneeUids: [] as string[],
      state: 'active' as const,
      updatedAt: 1,
    };
    await s.upsert({
      ...base,
      id: 't1',
      boardId: 'b1',
      key: 'ENG-42',
      title: 'Fix login',
      text: 'oauth <flow>',
    });
    await s.upsert({
      ...base,
      id: 't2',
      boardId: 'b2',
      key: 'OPS-1',
      title: 'Fix login too',
      text: '',
    });
    const r = await s.search({ q: 'login', boardIds: ['b1'] });
    expect(r.hits.map((h) => h.id)).toEqual(['t1']);
    expect(r.hits[0]!.snippet).toContain('<mark>login</mark>');
    expect((await s.search({ q: '42', boardIds: ['b1', 'b2'] })).hits.map((h) => h.id)).toEqual([
      't1',
    ]);
    expect((await s.search({ q: 'flow', boardIds: ['b1'] })).hits[0]!.snippet).toContain('&lt;');
    await s.delete('t1');
    expect((await s.search({ q: 'login', boardIds: ['b1'] })).found).toBe(0);
  });
});

describe('seqIds / toAppError', () => {
  it('deterministic ids', () => {
    const ids = seqIds();
    expect(ids.id()).toHaveLength(20);
    expect(ids.id()).not.toBe(ids.id());
  });
  it('maps thrown values', () => {
    expect(toAppError(new AppError('forbidden')).code).toBe('forbidden');
    expect(toAppError(z.string().safeParse(1).error).code).toBe('invalid');
    const orig = console.error;
    console.error = () => {};
    expect(toAppError(new Error('boom')).code).toBe('internal');
    console.error = orig;
  });
});
