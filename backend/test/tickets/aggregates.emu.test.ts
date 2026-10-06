/**
 * AGGREGATE FIELDS (docs/plan/aggregates.html) under the emulators:
 *
 *   an 'agg' message adds its entries to ticket.aggs, board.aggs and the
 *   period bucket aggStats/{period}:{key} of each field (daily / weekly /
 *   monthly) in the post's transaction; a replay counts once; a turn receipt
 *   is an entry on 'cost' (and still writes the legacy cost mirrors); an
 *   unknown or archived field is a 400; an agg message is never edited or
 *   deleted; boardUpdate archives a missing field and locks a counted field's
 *   period; boardCreate starts every board with Cost; the REST door names a
 *   field by id or label and reads the buckets back.
 */
import { describe, expect, it } from 'vitest';
import {
  aggPeriodKey,
  aggStatsId,
  COST_AGG_FIELD,
  costDayOf,
  paths,
  SCOPE_PRESETS,
  type AggFieldDef,
  type AggStats,
  type Board,
  type BoardDayStats,
  type Scope,
  type Ticket,
} from '@tm/shared';
import { call, fixedClock, setPorts, setupEmulators, uniq } from '../harness/index.js';
import { apiKeyFor, rest } from '../platform/helpers.js';
import { uniqKey } from '../boards/helpers.js';
import { doc, getDocData, people, seedBoard, spyPorts } from './helpers.js';
import { msgOf } from './store.js';

setupEmulators();

const NOW = Date.UTC(2026, 9, 5, 6, 0); // 2026-10-05 11:30 IST, a Monday
const TIME: AggFieldDef = {
  id: 'a_time01',
  label: 'Time',
  unit: 'h',
  period: 'weekly',
  position: 1,
  showOnCard: true,
};
const PAGES: AggFieldDef = {
  id: 'a_pages1',
  label: 'Pages',
  unit: '',
  period: 'monthly',
  position: 2,
};
const OLD: AggFieldDef = {
  id: 'a_old001',
  label: 'Old',
  unit: '',
  period: 'daily',
  position: 3,
  archived: true,
};
const FIELDS = [COST_AGG_FIELD, TIME, PAGES, OLD];

const T = (b: string, t: string) => getDocData<Ticket>(paths.ticket(b, t)).then((x) => x!);
const B = (b: string) => getDocData<Board>(paths.board(b)).then((x) => x!);
const bucket = (b: string, f: AggFieldDef, at = NOW) =>
  getDocData<AggStats>(paths.aggStat(b, aggStatsId(f.period, aggPeriodKey(f.period, at))));

async function setup() {
  spyPorts();
  setPorts({ clock: fixedClock(NOW) });
  const { asha, cora, vic } = await people('asha', 'cora', 'vic');
  const b = await seedBoard({
    admin: asha,
    commenters: [cora],
    viewers: [vic],
    patch: { aggFields: FIELDS },
  });
  const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
  const key = (await T(b.id, ticketId)).key;
  return { asha, cora, vic, b, ticketId, key };
}

describe('messagePost agg', () => {
  it('counts each entry into the ticket, the board and its period bucket; a replay counts once', async () => {
    const { cora, b, ticketId, key } = await setup();
    const clientId = uniq('c');
    const post = (id: string, entries: { fieldId: string; value: number }[], text?: string) =>
      call(cora, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: id,
        body: text ? doc(text) : { type: 'doc', content: [] },
        agg: { entries },
      });

    const r = await post(clientId, [
      { fieldId: TIME.id, value: 2.5 },
      { fieldId: PAGES.id, value: 3 },
    ]);
    const m = (await msgOf(b.id, ticketId, r.messageId))!;
    expect(m.kind).toBe('agg');
    expect(m.agg).toEqual({
      entries: [
        { fieldId: TIME.id, value: 2.5 },
        { fieldId: PAGES.id, value: 3 },
      ],
    });
    // No body given: the server writes one (notifications need words).
    expect(m.markdown).toBe('+2.5 h Time · +3 Pages');
    expect(m.body.text).toContain('+2.5 h Time');

    // A replay of the same post counts nothing twice.
    await post(clientId, [
      { fieldId: TIME.id, value: 2.5 },
      { fieldId: PAGES.id, value: 3 },
    ]);
    // A correction is another entry, with a note.
    await post(uniq('c'), [{ fieldId: TIME.id, value: -0.5 }], 'overcounted');

    const t = await T(b.id, ticketId);
    expect(t.aggs).toEqual({
      [TIME.id]: { total: 2, count: 2 },
      [PAGES.id]: { total: 3, count: 1 },
    });
    expect(t.cost).toBeUndefined(); // no cost entry, no legacy mirror
    expect((await B(b.id)).aggs).toEqual(t.aggs);

    const week = (await bucket(b.id, TIME))!;
    expect(week).toMatchObject({ period: 'weekly', key: '2026-W41' });
    expect(week.fields[TIME.id]).toEqual({
      total: 2,
      count: 2,
      tickets: { [key]: { total: 2, count: 2 } },
    });
    expect(week.fields[PAGES.id]).toBeUndefined();
    const month = (await bucket(b.id, PAGES))!;
    expect(month).toMatchObject({ period: 'monthly', key: '2026-10' });
    expect(month.fields[PAGES.id]).toMatchObject({ total: 3, count: 1 });
  });

  it('a backfilled entry (agg.at) lands in the bucket of the day it is FOR; future / too old refused', async () => {
    const { cora, b, ticketId, key } = await setup();
    const DAY = 86_400_000;
    const post = (at: number | undefined, value: number) =>
      call(cora, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: { type: 'doc', content: [] },
        agg: {
          ...(at !== undefined ? { at } : {}),
          entries: [{ fieldId: COST_AGG_FIELD.id, value }],
        },
      });
    const r = await post(NOW - 2 * DAY, 1.5);
    expect((await msgOf(b.id, ticketId, r.messageId))!.agg?.at).toBe(NOW - 2 * DAY);
    await post(undefined, 0.25);

    const then = (await bucket(b.id, COST_AGG_FIELD, NOW - 2 * DAY))!;
    expect(then.key).toBe(aggPeriodKey('daily', NOW - 2 * DAY));
    expect(then.fields[COST_AGG_FIELD.id]).toEqual({
      total: 1.5,
      count: 1,
      tickets: { [key]: { total: 1.5, count: 1 } },
    });
    expect((await bucket(b.id, COST_AGG_FIELD))!.fields[COST_AGG_FIELD.id]!.total).toBe(0.25);
    // The ticket's and the board's totals count both.
    expect((await T(b.id, ticketId)).aggs?.[COST_AGG_FIELD.id]).toEqual({ total: 1.75, count: 2 });

    await expect(post(NOW + 2 * DAY, 1)).rejects.toMatchObject({ code: 'invalid' });
    await expect(post(NOW - 500 * DAY, 1)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('an unknown or archived field is a 400; a viewer cannot post one', async () => {
    const { cora, vic, b, ticketId } = await setup();
    const post = (u: typeof cora, fieldId: string) =>
      call(u, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: { type: 'doc', content: [] },
        agg: { entries: [{ fieldId, value: 1 }] },
      });
    await expect(post(cora, 'a_nope00')).rejects.toMatchObject({
      code: 'invalid',
      details: { field: 'agg' },
    });
    await expect(post(cora, OLD.id)).rejects.toMatchObject({ code: 'invalid' });
    await expect(post(vic, TIME.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await T(b.id, ticketId)).aggs).toBeUndefined();
  });

  it('an agg message is never edited or deleted — not even by an admin', async () => {
    const { asha, cora, b, ticketId } = await setup();
    const { messageId } = await call(cora, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId: uniq('c'),
      body: { type: 'doc', content: [] },
      agg: { entries: [{ fieldId: TIME.id, value: 1 }] },
    });
    await expect(
      call(cora, 'messageEdit', { boardId: b.id, ticketId, messageId, body: doc('x') }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(asha, 'messageEdit', { boardId: b.id, ticketId, messageId, delete: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a turn receipt is an entry on cost (legacy mirrors too), merged with other entries', async () => {
    const { asha, b, ticketId, key } = await setup();
    const run = {
      n: 1,
      outcome: 'review' as const,
      costUsd: 1.25,
      sessionUsd: null,
      durationMs: 10,
      apiTurns: null,
      model: null,
      usage: null,
    };
    const { messageId } = await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId: uniq('c'),
      body: doc('Turn 1'),
      run,
      agg: { entries: [{ fieldId: TIME.id, value: 0.25 }] },
    });
    const m = (await msgOf(b.id, ticketId, messageId))!;
    expect(m.kind).toBe('comment');
    expect(m.agg!.entries).toEqual([
      { fieldId: 'cost', value: 1.25 },
      { fieldId: TIME.id, value: 0.25 },
    ]);
    const t = await T(b.id, ticketId);
    expect(t.aggs).toEqual({
      cost: { total: 1.25, count: 1 },
      [TIME.id]: { total: 0.25, count: 1 },
    });
    expect(t.cost).toEqual({ usd: 1.25, runs: 1 });
    expect((await B(b.id)).cost).toEqual({ usd: 1.25, runs: 1 });
    expect((await bucket(b.id, COST_AGG_FIELD))!.fields.cost).toEqual({
      total: 1.25,
      count: 1,
      tickets: { [key]: { total: 1.25, count: 1 } },
    });
    const day = await getDocData<BoardDayStats>(paths.stat(b.id, costDayOf(NOW)));
    expect(day).toMatchObject({ costUsd: 1.25, runs: 1 });

    // Beside a receipt, an entry may not name cost too.
    await expect(
      call(asha, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: doc('Turn 2'),
        run: { ...run, n: 2 },
        agg: { entries: [{ fieldId: 'cost', value: 1 }] },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a board from before aggregates: the receipt counts on Cost, seeded from the legacy counter', async () => {
    spyPorts();
    setPorts({ clock: fixedClock(NOW) });
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, patch: { cost: { usd: 10, runs: 4 } } });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId: uniq('c'),
      body: doc('Turn'),
      run: {
        n: 1,
        outcome: 'review',
        costUsd: 1,
        sessionUsd: null,
        durationMs: 1,
        apiTurns: null,
        model: null,
        usage: null,
      },
    });
    const board = await B(b.id);
    expect(board.aggs).toEqual({ cost: { total: 11, count: 5 } });
    expect(board.cost).toEqual({ usd: 11, runs: 5 });
  });
});

describe('boardUpdate aggFields', () => {
  it('adds, archives what is missing, refuses duplicate ids, and locks a counted period', async () => {
    const { asha, cora, b, ticketId } = await setup();
    const NEW: AggFieldDef = {
      id: 'a_new001',
      label: 'Km',
      unit: 'km',
      period: 'daily',
      position: 4,
    };
    // cora is no admin.
    await expect(
      call(cora, 'boardUpdate', { boardId: b.id, patch: { aggFields: [COST_AGG_FIELD] } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(asha, 'boardUpdate', { boardId: b.id, patch: { aggFields: [TIME, TIME] } }),
    ).rejects.toMatchObject({ code: 'invalid' });

    // PAGES left out → archived; NEW added; TIME relabelled; its period may still change (no entries).
    await call(asha, 'boardUpdate', {
      boardId: b.id,
      patch: { aggFields: [COST_AGG_FIELD, { ...TIME, label: 'Hours', period: 'daily' }, NEW] },
    });
    let fields = (await B(b.id)).aggFields!;
    expect(fields.map((f) => [f.id, f.label, f.period, !!f.archived])).toEqual([
      ['cost', 'Cost', 'daily', false],
      [TIME.id, 'Hours', 'daily', false],
      [NEW.id, 'Km', 'daily', false],
      [PAGES.id, 'Pages', 'monthly', true],
      [OLD.id, 'Old', 'daily', true],
    ]);

    // Once it counts, the period stays.
    await call(cora, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId: uniq('c'),
      body: { type: 'doc', content: [] },
      agg: { entries: [{ fieldId: NEW.id, value: 5 }] },
    });
    await expect(
      call(asha, 'boardUpdate', {
        boardId: b.id,
        patch: { aggFields: [COST_AGG_FIELD, TIME, { ...NEW, period: 'weekly' }] },
      }),
    ).rejects.toMatchObject({ code: 'invalid', details: { fieldId: NEW.id } });
    // …but label / unit / showOnCard may.
    await call(asha, 'boardUpdate', {
      boardId: b.id,
      patch: { aggFields: [COST_AGG_FIELD, TIME, { ...NEW, label: 'Distance', showOnCard: true }] },
    });
    fields = (await B(b.id)).aggFields!;
    expect(fields.find((f) => f.id === NEW.id)).toMatchObject({
      label: 'Distance',
      showOnCard: true,
    });
  });

  it('boardCreate starts every board with the Cost field', async () => {
    const { asha } = await people('asha');
    const { boardId } = await call(asha, 'boardCreate', { name: 'Fresh', key: uniqKey() });
    expect((await B(boardId)).aggFields).toEqual([COST_AGG_FIELD]);
  });
});

describe('the API door', () => {
  it('posts entries by label, states them on the message, the ticket and the board, and reads buckets', async () => {
    const { asha, b, key } = await setup();
    const { key: token } = await apiKeyFor(asha, [...SCOPE_PRESETS.everything] as Scope[], b.id);
    const r = await rest(token, 'POST', `/v1/tickets/${key}/messages`, {
      agg: {
        entries: [
          { field: 'time', value: 1.5 },
          { field_id: PAGES.id, value: 2 },
        ],
      },
    });
    expect(r.status).toBe(201);
    const m = r.body as { kind: string; body_md: string; agg: unknown };
    expect(m.kind).toBe('agg');
    expect(m.agg).toEqual({
      entries: [
        { field_id: TIME.id, value: 1.5 },
        { field_id: PAGES.id, value: 2 },
      ],
    });
    expect(m.body_md).toContain('+1.5 h Time');

    const bad = await rest(token, 'POST', `/v1/tickets/${key}/messages`, {
      agg: { entries: [{ field: 'Nope', value: 1 }] },
    });
    expect(bad.status).toBe(400);
    const archived = await rest(token, 'POST', `/v1/tickets/${key}/messages`, {
      agg: { entries: [{ field: 'Old', value: 1 }] },
    });
    expect(archived.status).toBe(400);

    const t = (await rest(token, 'GET', `/v1/tickets/${key}`)).body as {
      aggs: unknown;
      cost: unknown;
    };
    expect(t.aggs).toEqual({
      [TIME.id]: { total: 1.5, count: 1 },
      [PAGES.id]: { total: 2, count: 1 },
    });
    expect(t.cost).toBe(null);
    const board = (await rest(token, 'GET', '/v1/board')).body as {
      agg_fields: { id: string; show_on_card: boolean; archived: boolean }[];
      aggs: unknown;
    };
    expect(board.agg_fields.map((f) => [f.id, f.show_on_card, f.archived])).toEqual([
      ['cost', true, false],
      [TIME.id, true, false],
      [PAGES.id, false, false],
      [OLD.id, false, true],
    ]);
    expect(board.aggs).toEqual(t.aggs);

    const at = (r.body as { created_at: string }).created_at;
    const week = aggPeriodKey('weekly', Date.parse(at));
    const agg = await rest(token, 'GET', `/v1/boards/${b.key}/aggregates?field=Time`);
    expect(agg.status).toBe(200);
    expect(agg.body).toEqual({
      field: {
        id: TIME.id,
        label: 'Time',
        unit: 'h',
        period: 'weekly',
        show_on_card: true,
        archived: false,
      },
      total: { total: 1.5, count: 1 },
      buckets: [{ key: week, total: 1.5, count: 1, tickets: { [key]: { total: 1.5, count: 1 } } }],
    });
    const sdkForm = await rest(token, 'GET', `/v1/board/aggregates?field=${PAGES.id}&from=2000-01`);
    expect((sdkForm.body as { buckets: unknown[] }).buckets).toHaveLength(1);
    const wrongKey = await rest(
      token,
      'GET',
      `/v1/boards/${b.key}/aggregates?field=Time&from=2026-10`,
    );
    expect(wrongKey.status).toBe(400);
  });
});
