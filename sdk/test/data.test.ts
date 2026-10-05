/**
 * tm.artifacts.data(id) against a mocked fetch (docs/plan/agents.html §AA4).
 *
 * Two kinds of assertion. The plain ones: the verb, the path and the body of
 * every route. And the ones that matter: what the SDK SENDS is put through
 * @tm/shared's own readers (decodeJsonValue, parseWhereParam,
 * parseOrderByParam, the batch schema) — the very functions the server runs —
 * and what the server would ANSWER is made with its own writer
 * (encodeJsonValue). So "the SDK and the server agree about $date" is tested
 * against the server's code, not against a second copy of the rule.
 */
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_DATA_BATCH_MAX,
  ARTIFACT_DATA_WHERE_MAX,
  ARTIFACT_RESERVED_COLLECTIONS as SHARED_RESERVED,
  ARTIFACT_UPLOAD_MAX_BYTES,
  ArtifactDataBatchSchema,
  LIST_LIMIT_MAX,
  MCP_TOOLS,
  McpToolSchemas,
  decodeJsonDocument,
  encodeJsonValue,
  formatWhereParam,
  parseOrderByParam,
  parseWhereParam,
} from '@tm/shared';
import {
  ARTIFACT_DATA_LIMITS,
  ARTIFACT_RESERVED_COLLECTIONS,
  dataPath,
  decodeDataValue,
  encodeDataValue,
  formatDataWhere,
  serverTime,
} from '../src/data.js';
import { TmError } from '../src/errors.js';
import { mcpTools } from '../src/mcp.js';
import { mockFetch, problem, testClient } from './helpers.js';

const AT = new Date('2026-09-30T05:30:00.000Z');

/** What the backend's decoder is given: tagged stand-ins for a Timestamp and the server clock. */
const SERVER_DECODE = {
  date: (at: Date): Record<string, unknown> => ({ __ts: at.getTime() }),
  serverTime: (): Record<string, unknown> => ({ __now: true }),
};
/** …and its encoder: that stand-in is "the store's timestamp type". */
const SERVER_ENCODE = {
  asDate: (v: unknown) =>
    typeof (v as { __ts?: unknown })?.__ts === 'number' ? new Date((v as { __ts: number }).__ts) : null,
};

/** The repeated `where=` values of a recorded URL (the helper's `query` keeps only the last). */
const wheres = (url: string): string[] => new URL(url).searchParams.getAll('where');

describe('limits', () => {
  it('are the ones the server enforces', () => {
    expect(ARTIFACT_DATA_LIMITS.batchWrites).toBe(ARTIFACT_DATA_BATCH_MAX);
    expect(ARTIFACT_DATA_LIMITS.listLimit).toBe(LIST_LIMIT_MAX);
    expect(ARTIFACT_DATA_LIMITS.whereFilters).toBe(ARTIFACT_DATA_WHERE_MAX);
    expect(ARTIFACT_DATA_LIMITS.uploadBytes).toBe(ARTIFACT_UPLOAD_MAX_BYTES);
    expect([...ARTIFACT_RESERVED_COLLECTIONS]).toEqual([...SHARED_RESERVED]);
  });
});

describe('values: $date and $serverTime', () => {
  it('a Date goes out as $date, the sentinel as $serverTime, nested anywhere', () => {
    const sent = encodeDataValue({ at: AT, stamp: serverTime, nested: { list: [AT, 1, 'x', null] }, skip: undefined });
    expect(sent).toEqual({
      at: { $date: '2026-09-30T05:30:00.000Z' },
      stamp: { $serverTime: true },
      nested: { list: [{ $date: '2026-09-30T05:30:00.000Z' }, 1, 'x', null] },
    });
    expect(() => encodeDataValue({ at: new Date('nope') })).toThrow(/invalid Date/);
  });

  it('what is sent is what the SERVER decoder reads as a timestamp and its clock', () => {
    const sent = JSON.parse(JSON.stringify(encodeDataValue({ at: AT, updated: serverTime, n: 3 })));
    expect(decodeJsonDocument(sent, SERVER_DECODE)).toEqual({ at: { __ts: AT.getTime() }, updated: { __now: true }, n: 3 });
  });

  it('round trip: what the SERVER encoder answers comes back as a Date', () => {
    const stored = { at: { __ts: AT.getTime() }, days: [{ __ts: AT.getTime() }], name: 'x', map: { $date: 'a', other: 1 } };
    const wire = JSON.parse(JSON.stringify(encodeJsonValue(stored, SERVER_ENCODE)));
    const back = decodeDataValue(wire) as { at: Date; days: Date[]; name: string; map: unknown };
    expect(back.at).toBeInstanceOf(Date);
    expect(back.at.getTime()).toBe(AT.getTime());
    expect(back.days[0]!.toISOString()).toBe(AT.toISOString());
    // Two keys: a map that happens to have a "$date" key, not the escape.
    expect(back.map).toEqual({ $date: 'a', other: 1 });
    // …and writing that back sends the same instant again.
    expect(encodeDataValue(back.at)).toEqual({ $date: AT.toISOString() });
  });

  it('get revives $date by default and leaves it alone with { raw: true }', async () => {
    const doc = { id: '2026', path: '/scores/2026', exists: true, data: { at: { $date: AT.toISOString() }, total: 42 } };
    const f = mockFetch({ body: doc });
    const tm = testClient(f);
    const got = await tm.artifacts.data('a1').firestore.get<{ at: Date; total: number }>('scores/2026');
    expect(f.last()).toMatchObject({ method: 'GET', path: '/artifacts/a1/data/firestore/scores/2026' });
    expect(got.data!.at).toBeInstanceOf(Date);
    expect(got.data!.at.getTime()).toBe(AT.getTime());
    expect(got).toMatchObject({ id: '2026', path: '/scores/2026', exists: true });

    const raw = await tm.artifacts.data('a1', { raw: true }).firestore.get('scores/2026');
    expect(raw.data).toEqual({ at: { $date: AT.toISOString() }, total: 42 });
  });

  it('a missing document is exists: false, not an error', async () => {
    const f = mockFetch({ body: { id: 'x', path: '/scores/x', exists: false, data: null } });
    expect(await testClient(f).artifacts.data('a1').firestore.get('scores/x')).toEqual({ id: 'x', path: '/scores/x', exists: false, data: null });
  });
});

describe('paths', () => {
  it('encodes each segment on its own and drops empty ones', () => {
    expect(dataPath('/scores/2026/')).toBe('scores/2026');
    expect(dataPath('a b/ü?#/x%y')).toBe('a%20b/%C3%BC%3F%23/x%25y');
    expect(dataPath('')).toBe('');
    // The server decodes the rest of the URL as ONE string: that must give the path back.
    expect(decodeURIComponent(dataPath('a b/ü?#/x%y'))).toBe('a b/ü?#/x%y');
  });

  it("refuses '.' and '..' before a URL parser can fold them away", () => {
    expect(() => dataPath('scores/../../other')).toThrow(/not allowed/);
    const tm = testClient(mockFetch());
    expect(() => tm.artifacts.data('a1').files.url('./x')).toThrow(/not allowed/);
  });

  it('tells a document path from a collection path', async () => {
    const f = mockFetch({ body: {} });
    const fsx = testClient(f).artifacts.data('a1').firestore;
    await expect(fsx.get('scores')).rejects.toThrow(/DOCUMENT path/);
    expect(() => fsx.set('scores', {})).toThrow(/DOCUMENT path/);
    expect(() => fsx.add('scores/2026', {})).toThrow(/COLLECTION path/);
    await expect(fsx.list('scores/2026')).rejects.toThrow(/COLLECTION path/);
    expect(f.calls).toHaveLength(0);
  });

  it('the artifact id is encoded too, and required', () => {
    const tm = testClient(mockFetch());
    expect(() => tm.artifacts.data('')).toThrow(/required/);
  });
});

describe('firestore', () => {
  it('set, set merge, update, delete, add', async () => {
    const f = mockFetch({ body: { ok: true, id: '2026', path: '/scores/2026' } });
    const fsx = testClient(f).artifacts.data('a1').firestore;

    expect(await fsx.set('scores/2026', { total: 42, at: AT, stamp: serverTime })).toEqual({ ok: true, id: '2026', path: '/scores/2026' });
    expect(f.last()).toMatchObject({ method: 'PUT', path: '/artifacts/a1/data/firestore/scores/2026', query: {} });
    expect(f.last().body).toEqual({ total: 42, at: { $date: AT.toISOString() }, stamp: { $serverTime: true } });
    expect(f.last().headers['idempotency-key']).toBeTruthy();

    await fsx.set('scores/2026', { total: 43 }, { merge: true });
    expect(f.last().query).toEqual({ merge: '1' });

    await fsx.update('/scores/2026', { 'stats.count': 3 });
    expect(f.last()).toMatchObject({ method: 'PATCH', path: '/artifacts/a1/data/firestore/scores/2026', body: { 'stats.count': 3 } });

    f.queue({ body: { ok: true } });
    await fsx.set('scores/2026', {});
    expect(await fsx.delete('scores/2026')).toEqual({ ok: true });
    expect(f.last()).toMatchObject({ method: 'DELETE', path: '/artifacts/a1/data/firestore/scores/2026' });

    const g = mockFetch({ status: 201, body: { id: 'gen1', path: '/scores/gen1' } });
    expect(await testClient(g).artifacts.data('a1').firestore.add('scores', { total: 1 })).toEqual({ id: 'gen1', path: '/scores/gen1' });
    expect(g.last()).toMatchObject({ method: 'POST', path: '/artifacts/a1/data/firestore/scores', body: { total: 1 } });

    expect(() => fsx.set('scores/2026', [1, 2] as never)).toThrow(/plain object/);
  });

  it('list: where repeats, in the form the SERVER parser reads back', async () => {
    const f = mockFetch({ body: { data: [{ id: 'd1', path: '/scores/d1', exists: true, data: { at: { $date: AT.toISOString() } } }], next_cursor: 'd1' } });
    const page = await testClient(f)
      .artifacts.data('a1')
      .firestore.list('scores', {
        where: [
          ['status', '==', 'open'],
          ['n', '>', 5],
          ['tag', 'in', ['a', 'b,c']],
          ['at', '>=', AT],
          ['note', '==', 'a, b & c=d'],
        ],
        orderBy: ['at', 'desc'],
        limit: 50,
        startAfter: 'd0',
      });
    const call = f.last();
    expect(call).toMatchObject({ method: 'GET', path: '/artifacts/a1/data/firestore/scores' });
    expect(call.query).toMatchObject({ order_by: 'at,desc', limit: '50', start_after: 'd0' });
    expect(parseOrderByParam(call.query.order_by!)).toEqual(['at', 'desc']);

    const sent = wheres(call.url);
    expect(sent).toHaveLength(5);
    expect(sent.map((w) => parseWhereParam(w))).toEqual([
      ['status', '==', 'open'],
      ['n', '>', 5],
      ['tag', 'in', ['a', 'b,c']],
      ['at', '>=', { $date: AT.toISOString() }],
      ['note', '==', 'a, b & c=d'],
    ]);
    // Byte for byte what @tm/shared's own formatter writes.
    expect(sent[0]).toBe(formatWhereParam(['status', '==', 'open']));
    expect(formatDataWhere(['n', '>', 5])).toBe(formatWhereParam(['n', '>', 5]));

    expect(page.nextCursor).toBe('d1');
    expect(page.data[0]!.data!.at).toBeInstanceOf(Date);
  });

  it('list: a bare orderBy is ascending, and nothing is sent that was not asked', async () => {
    const f = mockFetch({ body: { data: [], next_cursor: null } });
    const fsx = testClient(f).artifacts.data('a1').firestore;
    await fsx.list('scores', { orderBy: 'total' });
    expect(f.last().query).toEqual({ order_by: 'total' });
    expect(parseOrderByParam('total')).toEqual(['total', 'asc']);
    await fsx.list('scores');
    expect(f.last().url).toBe('http://tm.test/v1/artifacts/a1/data/firestore/scores');
  });

  it('listAll follows next_cursor to the end', async () => {
    const doc = (id: string) => ({ id, path: `/scores/${id}`, exists: true, data: { id } });
    const f = mockFetch(
      { body: { data: [doc('a'), doc('b')], next_cursor: 'b' } },
      { body: { data: [doc('c'), doc('d')], next_cursor: 'd' } },
      { body: { data: [doc('e')], next_cursor: null } },
    );
    const seen: string[] = [];
    for await (const d of testClient(f).artifacts.data('a1').firestore.listAll('scores', { limit: 2, where: [['x', '==', 1]] })) seen.push(d.id);
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(f.calls.map((c) => c.query.start_after)).toEqual([undefined, 'b', 'd']);
    // The filter and the page size ride along on every page.
    for (const c of f.calls) {
      expect(c.query.limit).toBe('2');
      expect(wheres(c.url)).toEqual(['x,==,1']);
    }
  });

  it('batch: one request, a body the SERVER schema accepts, Dates encoded', async () => {
    const f = mockFetch({ body: { ok: true, written: 3 } });
    const out = await testClient(f)
      .artifacts.data('a1')
      .firestore.batch([
        { op: 'set', path: 'sales/2026-09-29', data: { total: 10, day: AT } },
        { op: 'set', path: 'meta/sales', data: { refreshed: serverTime }, merge: true },
        { op: 'update', path: 'meta/stats', data: { 'rows.count': 1 } },
        { op: 'delete', path: 'sales/2026-09-01' },
      ]);
    expect(out).toEqual({ ok: true, written: 3 });
    expect(f.calls).toHaveLength(1);
    expect(f.last()).toMatchObject({ method: 'POST', path: '/artifacts/a1/data/batch' });
    expect(f.last().body).toEqual({
      writes: [
        { op: 'set', path: 'sales/2026-09-29', data: { total: 10, day: { $date: AT.toISOString() } } },
        { op: 'set', path: 'meta/sales', data: { refreshed: { $serverTime: true } }, merge: true },
        { op: 'update', path: 'meta/stats', data: { 'rows.count': 1 } },
        { op: 'delete', path: 'sales/2026-09-01' },
      ],
    });
    expect(ArtifactDataBatchSchema.safeParse(f.last().body).success).toBe(true);
  });

  it('batch refuses none, and more than 400, before sending', () => {
    const f = mockFetch();
    const fsx = testClient(f).artifacts.data('a1').firestore;
    expect(() => fsx.batch([])).toThrow(/at least one/);
    const many = Array.from({ length: 401 }, (_, i) => ({ op: 'delete' as const, path: `x/${i}` }));
    let err: unknown;
    try {
      void fsx.batch(many);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TmError);
    expect((err as TmError).code).toBe('too_large');
    expect(f.calls).toHaveLength(0);
  });

  it('a refusal is a TmError with the server code', async () => {
    const f = mockFetch({ status: 403, body: problem('forbidden', 403, "This agent's data access on the artifact is 'read'") });
    const err = await testClient(f)
      .artifacts.data('a1')
      .firestore.set('scores/1', { a: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmError);
    expect(err).toMatchObject({ code: 'forbidden', status: 403 });
  });
});

describe('rtdb', () => {
  it('get unwraps the value; the root is a real address', async () => {
    const f = mockFetch({ body: { path: '/presence/u1', value: { online: true } } });
    const rt = testClient(f).artifacts.data('a1').rtdb;
    expect(await rt.get('presence/u1')).toEqual({ online: true });
    expect(f.last()).toMatchObject({ method: 'GET', path: '/artifacts/a1/data/rtdb/presence/u1' });
    f.queue({ body: { path: '/', value: null } });
    await rt.get('presence/u1');
    expect(await rt.get()).toBeNull();
    expect(f.last().path).toBe('/artifacts/a1/data/rtdb');
  });

  it('set, update, push, remove', async () => {
    const f = mockFetch({ body: { ok: true } });
    const rt = testClient(f).artifacts.data('a1').rtdb;
    await rt.set('counter', 5);
    expect(f.last()).toMatchObject({ method: 'PUT', path: '/artifacts/a1/data/rtdb/counter', raw: '5' });
    await rt.set('flag', false);
    expect(f.last().raw).toBe('false');
    await rt.set('gone', null);
    expect(f.last().raw).toBe('null');
    await rt.update('stats', { 'a/b': 1, at: AT, now: serverTime });
    expect(f.last()).toMatchObject({ method: 'PATCH', path: '/artifacts/a1/data/rtdb/stats' });
    expect(f.last().body).toEqual({ 'a/b': 1, at: { $date: AT.toISOString() }, now: { $serverTime: true } });
    await rt.remove('stats');
    expect(f.last()).toMatchObject({ method: 'DELETE', path: '/artifacts/a1/data/rtdb/stats' });
    f.queue({ status: 201, body: { key: '-Nabc', path: '/log/-Nabc' } });
    await rt.remove('x');
    expect(await rt.push('log', { msg: 'hi' })).toEqual({ key: '-Nabc', path: '/log/-Nabc' });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/artifacts/a1/data/rtdb/log', body: { msg: 'hi' } });
  });
});

describe('rtdb.push is not retried', () => {
  it('a 503 is thrown rather than pushed twice; asking for retries turns it back on', async () => {
    const f = mockFetch({ status: 503, body: {} }, { status: 201, body: { key: '-N1', path: '/log/-N1' } });
    const rt = testClient(f, { retry: 3 }).artifacts.data('a1').rtdb;
    await expect(rt.push('log', { msg: 'hi' })).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(1);

    const g = mockFetch({ status: 503, body: {} }, { status: 201, body: { key: '-N1', path: '/log/-N1' } });
    const out = await testClient(g, { retry: 3 }).artifacts.data('a1').rtdb.push('log', { msg: 'hi' }, { retry: { retries: 1 } });
    expect(out.key).toBe('-N1');
    expect(g.calls).toHaveLength(2);
  });
});

describe('files', () => {
  const FILE = { path: '/reports/q3.csv', size: 5, content_type: 'text/csv', updated_at: '2026-09-30T05:30:00.000Z' };
  const sentBlob = (sent: unknown): Blob => sent as Blob;

  it('upload: the raw body IS the file, with its content type', async () => {
    const f = mockFetch({ status: 201, body: FILE });
    const files = testClient(f).artifacts.data('a1').files;

    expect(await files.upload('reports/q3.csv', 'a,b\n1', { contentType: 'text/csv' })).toEqual(FILE);
    expect(f.last()).toMatchObject({ method: 'PUT', path: '/artifacts/a1/data/files/reports/q3.csv' });
    expect(f.last().headers['content-type']).toBe('text/csv');
    expect(await sentBlob(f.last().sent).text()).toBe('a,b\n1');

    await files.upload('notes.txt', 'héllo');
    expect(f.last().headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(new Uint8Array(await sentBlob(f.last().sent).arrayBuffer()).length).toBe(6); // UTF-8, not UTF-16

    await files.upload('img/a b.png', new Uint8Array([1, 2, 3]));
    expect(f.last().path).toBe('/artifacts/a1/data/files/img/a%20b.png');
    expect(f.last().headers['content-type']).toBe('application/octet-stream');
    expect([...new Uint8Array(await sentBlob(f.last().sent).arrayBuffer())]).toEqual([1, 2, 3]);

    await files.upload('x.json', new Blob(['{}'], { type: 'application/json' }));
    expect(f.last().headers['content-type']).toBe('application/json');
    await files.upload('x.json', new Blob(['{}'], { type: 'application/json' }), { contentType: 'text/plain' });
    expect(f.last().headers['content-type']).toBe('text/plain');
  });

  it('upload: over 25 MB is refused before it is sent', () => {
    const f = mockFetch();
    const files = testClient(f).artifacts.data('a1').files;
    let err: unknown;
    try {
      void files.upload('big.bin', new Uint8Array(ARTIFACT_UPLOAD_MAX_BYTES + 1));
    } catch (e) {
      err = e;
    }
    expect((err as TmError).code).toBe('too_large');
    expect(f.calls).toHaveLength(0);
  });

  it('upload: a retry sends the same bytes under the same Idempotency-Key', async () => {
    const f = mockFetch({ status: 503, body: {} }, { status: 201, body: FILE });
    await testClient(f, { retry: 1 }).artifacts.data('a1').files.upload('reports/q3.csv', 'a,b\n1');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.headers['idempotency-key']).toBe(f.calls[1]!.headers['idempotency-key']);
    expect(await sentBlob(f.calls[1]!.sent).text()).toBe('a,b\n1');
  });

  it('url, list, delete', async () => {
    const f = mockFetch({ body: { url: 'https://signed', expires_at: '2026-09-30T06:30:00.000Z' } });
    const files = testClient(f).artifacts.data('a1').files;
    expect((await files.url('reports/q3.csv')).url).toBe('https://signed');
    expect(f.last()).toMatchObject({ method: 'GET', path: '/artifacts/a1/data/files/reports/q3.csv' });

    f.queue({ body: { data: [FILE] } });
    await files.url('reports/q3.csv');
    expect(await files.list('reports/')).toEqual([FILE]);
    expect(f.last()).toMatchObject({ method: 'GET', path: '/artifacts/a1/data/files', query: { prefix: 'reports/' } });
    await files.list();
    expect(f.last().url).toBe('http://tm.test/v1/artifacts/a1/data/files');

    f.queue({ body: { ok: true } });
    await files.list();
    expect(await files.delete('reports/q3.csv')).toEqual({ ok: true });
    expect(f.last()).toMatchObject({ method: 'DELETE', path: '/artifacts/a1/data/files/reports/q3.csv' });
    expect(() => files.delete('')).toThrow(/needs a path/);
  });
});

describe('a pinned board rides along and changes nothing', () => {
  it('board= is added to data calls too (the routes ignore it)', async () => {
    const f = mockFetch({ body: { data: [], next_cursor: null } });
    await testClient(f, { board: 'ENG' }).artifacts.data('a1').firestore.list('scores', { where: [['n', '>', 1]] });
    expect(f.last().query.board).toBe('ENG');
    expect(wheres(f.last().url)).toEqual(['n,>,1']);
  });
});

describe('the artifact_data_* MCP tools', () => {
  const tool = async (f: ReturnType<typeof mockFetch>, name: string) =>
    (await mcpTools(testClient(f), { scopes: ['artifacts:write'] })).find((t) => t.name === name)!;

  it('arguments the SERVER schema accepts produce the matching REST call', async () => {
    const f = mockFetch({ body: { data: [{ id: 'd1', path: '/scores/d1', exists: true, data: { at: { $date: AT.toISOString() } } }], next_cursor: 'd1' } });
    const args = { id: 'a1', path: 'scores', where: [['status', '==', 'open']], order_by: 'at,desc', limit: 10, start_after: 'd0' };
    expect(McpToolSchemas.artifact_data_list.safeParse(args).success).toBe(true);
    const out = (await (await tool(f, 'artifact_data_list')).handler(args)) as { data: { data: unknown }[]; next_cursor: string };
    expect(f.last().query).toMatchObject({ order_by: 'at,desc', limit: '10', start_after: 'd0' });
    expect(wheres(f.last().url)).toEqual(['status,==,"open"']);
    // As /mcp answers: the wire's names, timestamps left as $date.
    expect(out.next_cursor).toBe('d1');
    expect(out.data[0]!.data).toEqual({ at: { $date: AT.toISOString() } });
  });

  it('get, set and batch', async () => {
    const f = mockFetch({ body: { id: '2026', path: '/scores/2026', exists: true, data: { at: { $date: AT.toISOString() } } } });
    const got = (await (await tool(f, 'artifact_data_get')).handler({ id: 'a1', path: 'scores/2026' })) as { data: unknown };
    expect(got.data).toEqual({ at: { $date: AT.toISOString() } });

    f.queue({ body: { ok: true, id: '2026', path: '/scores/2026' } });
    await (await tool(f, 'artifact_data_get')).handler({ id: 'a1', path: 'scores/2026' });
    await (await tool(f, 'artifact_data_set')).handler({ id: 'a1', path: 'scores/2026', data: { at: { $date: AT.toISOString() } }, merge: true });
    expect(f.last()).toMatchObject({ method: 'PUT', path: '/artifacts/a1/data/firestore/scores/2026', query: { merge: '1' } });
    expect(f.last().body).toEqual({ at: { $date: AT.toISOString() } });

    f.queue({ body: { ok: true, written: 1 } });
    await (await tool(f, 'artifact_data_set')).handler({ id: 'a1', path: 'scores/2026', data: {} });
    const writes = [{ op: 'delete', path: 'scores/2025' }];
    expect(McpToolSchemas.artifact_data_batch.safeParse({ id: 'a1', writes }).success).toBe(true);
    expect(await (await tool(f, 'artifact_data_batch')).handler({ id: 'a1', writes })).toEqual({ ok: true, written: 1 });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/artifacts/a1/data/batch', body: { writes } });
  });

  it('the write tools are hidden from a read-only credential', async () => {
    const names = (await mcpTools(testClient(mockFetch()), { scopes: ['artifacts:read'] })).map((t) => t.name);
    expect(names).toContain('artifact_data_get');
    expect(names).toContain('artifact_data_list');
    expect(names).not.toContain('artifact_data_set');
    expect(names).not.toContain('artifact_data_batch');
    expect(MCP_TOOLS.artifact_data_set.readOnly).toBe(false);
  });
});
