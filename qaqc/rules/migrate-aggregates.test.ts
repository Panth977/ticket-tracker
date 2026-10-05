/**
 * scripts/lib/aggregates.mjs against the firestore emulator: seed boards with
 * the legacy cost counters, day stats and receipt messages (inline and in a
 * data page), run the migration dry and then for real, check the aggregate
 * shape, then run it again: nothing may change.
 *
 * Not a rules suite — it lives here because this project runs with the
 * emulators up (`pnpm --filter @tm/qaqc test:rules`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, type Firestore } from 'firebase/firestore';
import * as S from '@tm/shared';
import type { Summary } from '../../scripts/lib/aggregates.mjs';
import { PROJECT_ID, boardDoc, fs, makeEnv } from './_env.js';

const here = dirname(fileURLToPath(import.meta.url));
const OWNER = 'u_agg_owner';
const B1 = 'board_agg1'; // receipts, stats, no aggFields
const B2 = 'board_agg2'; // aggFields without cost (Time, weekly)
const B3 = 'board_agg3'; // cost archived — fields left alone
const TIME = { id: 'a_time01', label: 'Time', unit: 'h', period: 'weekly', position: 0 };

const receipt = (id: string, costUsd: number, at: number) => ({
  id,
  kind: 'comment',
  body: 'turn',
  createdAt: at,
  deletedAt: null,
  run: {
    n: 1,
    outcome: 'review',
    costUsd,
    sessionUsd: null,
    durationMs: 10,
    apiTurns: 1,
    model: null,
    usage: null,
  },
});

let env: RulesTestEnvironment;

function run(apply: boolean): Summary {
  const r = spawnSync(
    process.execPath,
    [
      '--conditions=@tm/source',
      '--import',
      'tsx',
      resolve(here, '_migrate-runner.ts'),
      JSON.stringify({
        projectId: PROJECT_ID,
        bucket: PROJECT_ID,
        ownerUid: OWNER,
        apply,
        now: 1_000,
        which: 'aggregates',
      }),
    ],
    { cwd: resolve(here, '..'), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  const last = (r.stdout ?? '').split('\n').find((l) => l.startsWith('SUMMARY '));
  if (r.status !== 0 || !last)
    throw new Error(`migration failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(last.slice('SUMMARY '.length)) as Summary;
}

async function admin<T>(fn: (db: Firestore) => Promise<T>): Promise<T> {
  let out!: T;
  await env.withSecurityRulesDisabled(async (ctx) => {
    out = await fn(fs(ctx));
  });
  return out;
}
const read = (path: string) => admin(async (db) => (await getDoc(doc(db, path))).data());

beforeAll(async () => {
  env = await makeEnv({ firestore: true });
  await env.clearFirestore();
  await admin(async (db) => {
    await setDoc(doc(db, `boards/${B1}`), {
      ...boardDoc({ [OWNER]: 'admin' }, 'Agg', 'AGG'),
      cost: { usd: 1.5, runs: 3 },
    });
    await setDoc(doc(db, `boards/${B1}/tickets/tkt_1`), {
      key: 'AGG-1',
      cost: { usd: 1.25, runs: 2 },
      pageCount: 1,
      recentMessages: [receipt('m2', 0.75, 20), { id: 'm3', kind: 'comment', body: 'hi' }],
    });
    await setDoc(doc(db, `boards/${B1}/tickets/tkt_1/data/000`), {
      page: 0,
      messages: [receipt('m1', 0.5, 10)],
      activity: [],
      from: 10,
      to: 10,
      createdAt: 10,
    });
    await setDoc(doc(db, `boards/${B1}/tickets/tkt_2`), {
      key: 'AGG-2',
      cost: { usd: 0.25, runs: 1 },
      recentMessages: [receipt('m4', 0.25, 30)],
    });
    await setDoc(doc(db, `boards/${B1}/tickets/tkt_3`), { key: 'AGG-3', recentMessages: [] });
    await setDoc(doc(db, `boards/${B1}/stats/2026-09-26`), {
      day: '2026-09-26',
      costUsd: 1.5,
      runs: 3,
      tickets: { 'AGG-1': { usd: 1.25, runs: 2 }, 'AGG-2': { usd: 0.25, runs: 1 } },
      updatedAt: 40,
    });
    // A daily doc that already holds another daily field: it must survive.
    await setDoc(doc(db, `boards/${B1}/aggStats/daily:2026-09-26`), {
      period: 'daily',
      key: '2026-09-26',
      fields: { a_other1: { total: 7, count: 1, tickets: { 'AGG-3': { total: 7, count: 1 } } } },
      updatedAt: 60,
    });
    await setDoc(doc(db, `boards/${B2}`), {
      ...boardDoc({ [OWNER]: 'admin' }, 'Two', 'TWO'),
      aggFields: [TIME],
    });
    await setDoc(doc(db, `boards/${B3}`), {
      ...boardDoc({ [OWNER]: 'admin' }, 'Three', 'THR'),
      aggFields: [{ ...S.COST_AGG_FIELD, archived: true }],
      aggs: { cost: { total: 0, count: 0 } },
    });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('cost → aggregate field migration (emulator)', () => {
  it('a dry run plans and writes nothing', async () => {
    const dry = run(false);
    expect(dry).toMatchObject({
      boards: 3,
      boardsToChange: 2,
      aggFieldsAdded: 2,
      boardCounters: 1,
      tickets: 3,
      ticketsToChange: 2,
      ticketCounters: 2,
      messages: 3,
      statDays: 1,
      aggStatsToWrite: 1,
      applied: { boards: 0, tickets: 0, aggStats: 0, failed: [] },
    });
    expect((await read(`boards/${B1}`))?.aggFields).toBeUndefined();
    expect((await read(`boards/${B1}/aggStats/daily:2026-09-26`))?.fields.cost).toBeUndefined();
  });

  it('--apply writes the aggregate shape', async () => {
    const s = run(true);
    expect(s.applied).toEqual({ boards: 2, tickets: 2, aggStats: 1, failed: [] });

    const b1 = await read(`boards/${B1}`);
    expect(b1?.aggFields).toEqual([S.COST_AGG_FIELD]);
    expect(b1?.aggs).toEqual({ cost: { total: 1.5, count: 3 } });
    expect(b1?.cost).toEqual({ usd: 1.5, runs: 3 }); // legacy kept
    expect(S.BoardSchema.shape.aggFields.safeParse(b1?.aggFields).success).toBe(true);

    const b2 = await read(`boards/${B2}`);
    expect(b2?.aggFields.map((f: { id: string }) => f.id)).toEqual(['cost', 'a_time01']);
    expect(b2?.aggs).toBeUndefined();

    const b3 = await read(`boards/${B3}`);
    expect(b3?.aggFields).toEqual([{ ...S.COST_AGG_FIELD, archived: true }]);

    const t1 = await read(`boards/${B1}/tickets/tkt_1`);
    expect(t1?.aggs).toEqual({ cost: { total: 1.25, count: 2 } });
    expect(t1?.recentMessages[0].agg).toEqual({ entries: [{ fieldId: 'cost', value: 0.75 }] });
    expect(t1?.recentMessages[1].agg).toBeUndefined();
    const page = await read(`boards/${B1}/tickets/tkt_1/data/000`);
    expect(page?.messages[0].agg).toEqual({ entries: [{ fieldId: 'cost', value: 0.5 }] });
    for (const m of [...t1!.recentMessages, ...page!.messages])
      expect(S.StoredMessageSchema.shape.agg.safeParse(m.agg).success).toBe(true);
    expect((await read(`boards/${B1}/tickets/tkt_2`))?.aggs).toEqual({
      cost: { total: 0.25, count: 1 },
    });
    expect((await read(`boards/${B1}/tickets/tkt_3`))?.aggs).toBeUndefined();

    const day = await read(`boards/${B1}/aggStats/daily:2026-09-26`);
    expect(day).toEqual({
      period: 'daily',
      key: '2026-09-26',
      fields: {
        a_other1: { total: 7, count: 1, tickets: { 'AGG-3': { total: 7, count: 1 } } },
        cost: {
          total: 1.5,
          count: 3,
          tickets: { 'AGG-1': { total: 1.25, count: 2 }, 'AGG-2': { total: 0.25, count: 1 } },
        },
      },
      updatedAt: 60,
    });
    expect(S.AggStatsSchema.safeParse(day).success).toBe(true);
  });

  it('a re-run changes nothing', async () => {
    const again = run(true);
    expect(again).toMatchObject({
      boardsToChange: 0,
      ticketsToChange: 0,
      messages: 0,
      aggStatsToWrite: 0,
      corrections: [],
      applied: { boards: 0, tickets: 0, aggStats: 0, failed: [] },
    });
  });

  it('a counter that drifted from the legacy one is corrected', async () => {
    await admin((db) =>
      setDoc(
        doc(db, `boards/${B1}/tickets/tkt_2`),
        { aggs: { cost: { total: 9, count: 9 } } },
        { merge: true },
      ),
    );
    const s = run(true);
    expect(s.ticketsToChange).toBe(1);
    expect(s.corrections).toHaveLength(1);
    expect((await read(`boards/${B1}/tickets/tkt_2`))?.aggs).toEqual({
      cost: { total: 0.25, count: 1 },
    });
  });
});
