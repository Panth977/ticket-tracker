/** The search module without emulators: memory index semantics, Typesense params, doc builder, counts. */
import { describe, expect, it } from 'vitest';
import type { Message, TicketDoc } from '@tm/shared';
import {
  buildTicketDoc,
  countsDelta,
  createSearchIndex,
  indexedFieldsChanged,
  memorySearchIndex,
  scopedKeyParams,
  searchParams,
  snippet,
  ticketCountBuckets,
  TICKETS_SCHEMA,
  tokenize,
  typesenseSearchIndex,
} from '../../src/search/index.js';

const doc = (over: Partial<TicketDoc> & { id: string }): TicketDoc => ({
  boardId: 'b1',
  key: 'ENG-1',
  title: 'Untitled',
  text: '',
  stageCategory: 'todo',
  assigneeUids: [],
  state: 'active',
  updatedAt: 1,
  ...over,
});

async function seeded() {
  const idx = memorySearchIndex();
  await idx.upsert(doc({ id: 't42', key: 'ENG-42', title: 'Fix login redirect', updatedAt: 10 }));
  await idx.upsert(
    doc({
      id: 't7',
      key: 'ENG-7',
      title: 'Logout button',
      text: 'the login page too',
      updatedAt: 20,
    }),
  );
  await idx.upsert(
    doc({ id: 't142', key: 'OPS-142', boardId: 'b2', title: 'Rotate keys', updatedAt: 30 }),
  );
  await idx.upsert(
    doc({
      id: 'tdone',
      key: 'ENG-9',
      title: 'Login metrics',
      stageCategory: 'done',
      assigneeUids: ['u1'],
      updatedAt: 5,
    }),
  );
  return idx;
}
const ids = (r: { hits: { id: string }[] }) => r.hits.map((h) => h.id);

describe('memory search index', () => {
  it('finds a key by infix: "42" → ENG-42 and OPS-142, only on readable boards', async () => {
    const idx = await seeded();
    expect(ids(await idx.search({ q: '42', boardIds: ['b1'] }))).toEqual(['t42']);
    expect(ids(await idx.search({ q: '42', boardIds: ['b1', 'b2'] })).sort()).toEqual([
      't142',
      't42',
    ]);
    expect(ids(await idx.search({ q: 'NG-4', boardIds: ['b1'] }))).toEqual(['t42']);
    expect(ids(await idx.search({ q: '#ENG-42', boardIds: ['b1'] }))).toEqual(['t42']);
    expect(ids(await idx.search({ q: '42', boardIds: [] }))).toEqual([]);
  });

  it('prefix-matches the last word of title/text; earlier words must be whole', async () => {
    const idx = await seeded();
    // title match (weight 2) outranks a text match (weight 1)
    expect(ids(await idx.search({ q: 'logi', boardIds: ['b1'] }))).toEqual(['t42', 'tdone', 't7']);
    expect(ids(await idx.search({ q: 'fix log', boardIds: ['b1'] }))).toEqual(['t42']);
    expect(ids(await idx.search({ q: 'fi login', boardIds: ['b1'] }))).toEqual([]);
    // no infix on titles
    expect(ids(await idx.search({ q: 'ogin', boardIds: ['b1'] }))).toEqual([]);
  });

  it('empty or * query lists newest first; filters are exact', async () => {
    const idx = await seeded();
    expect(ids(await idx.search({ q: '', boardIds: ['b1'] }))).toEqual(['t7', 't42', 'tdone']);
    expect(ids(await idx.search({ q: '*', boardIds: ['b1'], limit: 1 }))).toEqual(['t7']);
    expect((await idx.search({ q: '*', boardIds: ['b1'], limit: 1 })).found).toBe(3);
    expect(
      ids(await idx.search({ q: 'login', boardIds: ['b1'], stageCategory: ['done'] })),
    ).toEqual(['tdone']);
    expect(ids(await idx.search({ q: '', boardIds: ['b1'], assigneeUids: ['u1'] }))).toEqual([
      'tdone',
    ]);
    expect(ids(await idx.search({ q: '', boardIds: ['b1'], state: ['archived'] }))).toEqual([]);
  });

  it('upsert replaces, delete removes, snippet marks the matched word', async () => {
    const idx = await seeded();
    await idx.upsert(doc({ id: 't42', key: 'ENG-42', title: 'Renamed', updatedAt: 99 }));
    expect(ids(await idx.search({ q: 'redirect', boardIds: ['b1'] }))).toEqual([]);
    await idx.delete('t7');
    await idx.delete('missing');
    const r = await idx.search({ q: 'login', boardIds: ['b1'] });
    expect(ids(r)).toEqual(['tdone']);
    expect(r.hits[0]!.snippet).toBe('<mark>Login</mark> metrics');
    expect(snippet('a <b> login', 'log')).toBe('a &lt;b&gt; <mark>login</mark>');
  });

  it('scoped key encodes the boards and expiry', async () => {
    const { key, host } = await memorySearchIndex().scopedKey(['b1', 'b2'], 5000);
    expect(host).toBe('memory');
    const payload = JSON.parse(Buffer.from(key.slice(4), 'base64url').toString());
    expect(payload).toEqual({ filter_by: 'boardId:[b1,b2]', expires_at: 5000 });
  });

  it('tokenizes like token_separators ["-"]', () => {
    expect(tokenize('ENG-42 Fix, login!')).toEqual(['eng', '42', 'fix', 'login']);
  });
});

describe('typesense adapter', () => {
  it('schema: infix on key only, facets for every filter', () => {
    const f = Object.fromEntries(TICKETS_SCHEMA.fields!.map((x) => [x.name, x]));
    expect(TICKETS_SCHEMA.name).toBe('tickets');
    expect(f.key!.infix).toBe(true);
    expect(f.title!.infix).toBeUndefined();
    for (const k of ['boardId', 'stageCategory', 'assigneeUids', 'state'])
      expect(f[k]!.facet).toBe(true);
    expect(TICKETS_SCHEMA.default_sorting_field).toBe('updatedAt');
  });

  it('search params always filter by board; scoped key params embed the filter', () => {
    const p = searchParams({ q: ' 42 ', boardIds: ['b1', 'we`ird'], state: ['active'] });
    expect(p.q).toBe('42');
    expect(p.query_by).toBe('key,title,text');
    expect(p.infix).toEqual(['always', 'off', 'off']);
    expect(p.filter_by).toBe('boardId:[`b1`,`weird`] && state:[`active`]');
    expect(searchParams({ q: '', boardIds: ['b'] }).q).toBe('*');
    expect(scopedKeyParams(['b1'], 3_600_500)).toEqual({
      filter_by: 'boardId:[`b1`]',
      expires_at: 3600,
    });
  });

  it('generates a real scoped key offline and never searches without boards', async () => {
    const idx = typesenseSearchIndex({
      TYPESENSE_HOST: 'ts.invalid',
      TYPESENSE_API_KEY: 'admin',
      TYPESENSE_SEARCH_KEY: 'searchonly',
    });
    const { key, host } = await idx.scopedKey(['b1'], 7_200_000);
    expect(host).toBe('https://ts.invalid:443');
    const decoded = Buffer.from(key, 'base64').toString();
    expect(decoded.slice(44, 48)).toBe('sear'); // digest(44) + parent key prefix(4)
    expect(JSON.parse(decoded.slice(48))).toEqual({
      filter_by: 'boardId:[`b1`]',
      expires_at: 7200,
    });
    expect(await idx.search({ q: 'x', boardIds: [] })).toEqual({ hits: [], found: 0 });
  });

  it('createSearchIndex picks memory without env', () => {
    expect('all' in createSearchIndex({})).toBe(true);
    expect('all' in createSearchIndex({ TYPESENSE_HOST: 'h', TYPESENSE_API_KEY: 'k' })).toBe(false);
  });
});

describe('buildTicketDoc', () => {
  const rt = (text: string) => ({
    doc: { type: 'doc' as const, content: [] },
    text,
    mentions: [],
    refs: [],
  });
  const msg = (text: string, over: Partial<Message> = {}) =>
    ({ kind: 'comment', deletedAt: null, body: rt(text), ...over }) as Pick<
      Message,
      'kind' | 'deletedAt' | 'body'
    >;
  const ticket = {
    key: 'ENG-42',
    title: 'Fix login',
    description: rt('Steps to reproduce'),
    stageCategory: 'active' as const,
    assigneeUids: ['u1'],
    state: 'active' as const,
    updatedAt: 7,
  };

  it('folds description + live comments, oldest → newest, max 20', () => {
    const newestFirst = [
      msg('m25'),
      msg('gone', { deletedAt: 1 }),
      msg('moved to QA', { kind: 'system' }),
      ...Array.from({ length: 24 }, (_, i) => msg(`m${24 - i}`)),
    ];
    const d = buildTicketDoc({ boardId: 'b', ticketId: 't' }, ticket, newestFirst);
    const lines = d.text.split('\n');
    expect(lines[0]).toBe('Steps to reproduce');
    expect(lines.slice(1)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 6}`));
    expect(d).toMatchObject({
      id: 't',
      boardId: 'b',
      key: 'ENG-42',
      assigneeUids: ['u1'],
      updatedAt: 7,
    });
  });

  it('caps text, keeping the newest messages', () => {
    const big = 'x'.repeat(30_000);
    const d = buildTicketDoc({ boardId: 'b', ticketId: 't' }, { ...ticket, description: rt(big) }, [
      msg('newest ' + 'y'.repeat(20_000)),
    ]);
    expect(d.text.length).toBeLessThanOrEqual(32_000);
    expect(d.text.endsWith('y')).toBe(true);
    expect(d.text.startsWith('x')).toBe(true);
  });

  it('indexedFieldsChanged ignores derived fields', () => {
    const base = { ...ticket, rank: 'a', counts: { messages: 1, files: 0, pinned: 0 } };
    expect(indexedFieldsChanged(base, { ...base, rank: 'b', updatedAt: 9 })).toBe(false);
    expect(indexedFieldsChanged(base, { ...base, title: 'New' })).toBe(true);
    expect(indexedFieldsChanged(base, { ...base, description: rt('changed') })).toBe(true);
    expect(indexedFieldsChanged(undefined, base)).toBe(true);
  });
});

describe('board counts', () => {
  const t = (over: object = {}) => ({
    state: 'active' as const,
    stageCategory: 'todo' as const,
    dueAt: null as number | null,
    dueAllDay: false,
    ...over,
  });
  const NOW = Date.UTC(2026, 0, 10, 12);

  it('buckets by state and stage category', () => {
    expect(ticketCountBuckets(t(), NOW)).toEqual({ active: 1, done: 0, overdue: 0 });
    expect(ticketCountBuckets(t({ dueAt: NOW - 1 }), NOW)).toEqual({
      active: 1,
      done: 0,
      overdue: 1,
    });
    expect(ticketCountBuckets(t({ stageCategory: 'done', dueAt: NOW - 1 }), NOW)).toEqual({
      active: 0,
      done: 1,
      overdue: 0,
    });
    expect(ticketCountBuckets(t({ stageCategory: 'cancelled' }), NOW)).toEqual({
      active: 0,
      done: 0,
      overdue: 0,
    });
    expect(ticketCountBuckets(t({ state: 'archived' }), NOW)).toEqual({
      active: 0,
      done: 0,
      overdue: 0,
    });
    expect(ticketCountBuckets(null, NOW)).toEqual({ active: 0, done: 0, overdue: 0 });
    // all-day: due for the whole UTC day
    const today = Date.UTC(2026, 0, 10);
    expect(ticketCountBuckets(t({ dueAt: today, dueAllDay: true }), NOW).overdue).toBe(0);
    expect(ticketCountBuckets(t({ dueAt: today - 86_400_000, dueAllDay: true }), NOW).overdue).toBe(
      1,
    );
  });

  it('delta = after − before', () => {
    expect(countsDelta(null, t(), NOW)).toEqual({ active: 1, done: 0, overdue: 0 });
    expect(
      countsDelta(t({ dueAt: NOW - 5 }), t({ stageCategory: 'done', dueAt: NOW - 5 }), NOW),
    ).toEqual({
      active: -1,
      done: 1,
      overdue: -1,
    });
    expect(countsDelta(t(), t({ state: 'archived' }), NOW)).toEqual({
      active: -1,
      done: 0,
      overdue: 0,
    });
    expect(countsDelta(t({ stageCategory: 'done' }), undefined, NOW)).toEqual({
      active: 0,
      done: -1,
      overdue: 0,
    });
  });
});
