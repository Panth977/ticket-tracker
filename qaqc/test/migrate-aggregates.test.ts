/**
 * scripts/lib/aggregates.mjs — the pure planning half of the cost → aggregate
 * field migration (the emulator half is rules/migrate-aggregates.test.ts).
 */
import { describe, expect, it } from 'vitest';
import * as S from '@tm/shared';
import {
  aggForMessage,
  planAggFields,
  planBoard,
  planCostCounter,
  planStatDay,
  planTicket,
  rewriteMessages,
} from '../../scripts/lib/aggregates.mjs';

const run = (costUsd: number) => ({
  n: 1,
  outcome: 'review',
  costUsd,
  sessionUsd: null,
  durationMs: 1,
  apiTurns: null,
  model: null,
  usage: null,
});
const time = { id: 'a_time01', label: 'Time', unit: 'h', period: 'weekly', position: 0 };

describe('planAggFields', () => {
  it('absent → [Cost]', () => {
    expect(planAggFields(S, undefined)).toEqual([S.COST_AGG_FIELD]);
  });
  it('a list without cost gets Cost first, the rest untouched', () => {
    const out = planAggFields(S, [time])!;
    expect(out.map((f) => f.id)).toEqual(['cost', 'a_time01']);
    expect(out[0]!.position).toBe(-1);
    expect(out[1]).toEqual(time);
    expect(out.every((f) => S.AggFieldDefSchema.safeParse(f).success)).toBe(true);
  });
  it('a list with cost — even archived — is left alone', () => {
    expect(planAggFields(S, [{ ...S.COST_AGG_FIELD, archived: true }])).toBeNull();
    expect(planAggFields(S, [S.COST_AGG_FIELD, time])).toBeNull();
  });
  it('an empty list gets Cost at 0', () => {
    expect(planAggFields(S, [])).toEqual([S.COST_AGG_FIELD]);
  });
});

describe('planCostCounter / planBoard', () => {
  it('no legacy cost → nothing', () => {
    expect(planCostCounter(S, {})).toEqual({});
  });
  it('absent aggs.cost → set from cost', () => {
    expect(planCostCounter(S, { cost: { usd: 1.5, runs: 3 } })).toEqual({
      set: { total: 1.5, count: 3 },
    });
  });
  it('equal → nothing (idempotent)', () => {
    expect(
      planCostCounter(S, { cost: { usd: 1.5, runs: 3 }, aggs: { cost: { total: 1.5, count: 3 } } }),
    ).toEqual({});
  });
  it('different → the legacy counter wins, reported', () => {
    const r = planCostCounter(S, {
      cost: { usd: 2, runs: 4 },
      aggs: { cost: { total: 0.5, count: 1 } },
    });
    expect(r.set).toEqual({ total: 2, count: 4 });
    expect(r.correction).toBeTruthy();
  });
  it('a board patch: fields + counter; then nothing', () => {
    const board = { key: 'ENG', cost: { usd: 3.25, runs: 2 } };
    const p = planBoard(S, board).patch!;
    expect(p.aggFields).toEqual([S.COST_AGG_FIELD]);
    expect(p['aggs.cost']).toEqual({ total: 3.25, count: 2 });
    expect(
      planBoard(S, { ...board, aggFields: p.aggFields, aggs: { cost: p['aggs.cost'] } }).patch,
    ).toBeNull();
  });
  it('a board with no cost still gets the field', () => {
    expect(planBoard(S, { key: 'OPS' }).patch).toEqual({ aggFields: [S.COST_AGG_FIELD] });
  });
});

describe('messages', () => {
  it('a receipt without agg gets the cost entry', () => {
    expect(aggForMessage(S, { run: run(0.42) })).toEqual({
      entries: [{ fieldId: 'cost', value: 0.42 }],
    });
    expect(S.MessageAggSchema.safeParse(aggForMessage(S, { run: run(0) })).success).toBe(true);
  });
  it('a plain comment or a receipt with agg is untouched', () => {
    expect(aggForMessage(S, { kind: 'comment' })).toBeNull();
    expect(aggForMessage(S, { run: run(1), agg: { entries: [] } })).toBeNull();
    const msgs = [{ id: 'a' }, { id: 'b', run: run(1) }];
    const r = rewriteMessages(S, msgs);
    expect(r.changed).toBe(1);
    expect(r.messages[0]).toBe(msgs[0]);
    expect(rewriteMessages(S, r.messages).changed).toBe(0);
  });
});

describe('planTicket', () => {
  it('counter + inline receipts; then nothing', () => {
    const t = {
      key: 'ENG-1',
      cost: { usd: 1, runs: 1 },
      recentMessages: [{ id: 'm1', kind: 'comment', run: run(1) }],
    };
    const p = planTicket(S, t);
    expect(p.messages).toBe(1);
    expect(p.patch!['aggs.cost']).toEqual({ total: 1, count: 1 });
    const after = {
      ...t,
      aggs: { cost: p.patch!['aggs.cost'] },
      recentMessages: p.patch!.recentMessages,
    };
    expect(planTicket(S, after).patch).toBeNull();
  });
  it('a ticket without cost or receipts → null', () => {
    expect(planTicket(S, { key: 'ENG-2', recentMessages: [{ id: 'x' }] }).patch).toBeNull();
  });
});

describe('planStatDay', () => {
  const stat = {
    day: '2026-09-26',
    costUsd: 1.24,
    runs: 2,
    tickets: { 'ENG-1': { usd: 1, runs: 1 }, 'ENG-2': { usd: 0.24, runs: 1 } },
    updatedAt: 50,
  };
  it('a missing doc → create, valid against AggStatsSchema', () => {
    const r = planStatDay(S, stat, undefined, 9);
    expect(r.write!.create).toEqual({
      period: 'daily',
      key: '2026-09-26',
      fields: {
        cost: {
          total: 1.24,
          count: 2,
          tickets: { 'ENG-1': { total: 1, count: 1 }, 'ENG-2': { total: 0.24, count: 1 } },
        },
      },
      updatedAt: 50,
    });
    expect(S.AggStatsSchema.safeParse(r.write!.create).success).toBe(true);
  });
  it('an existing doc with another field → patch fields.cost only', () => {
    const ex = {
      period: 'daily',
      key: '2026-09-26',
      fields: { a_time01: { total: 2, count: 1, tickets: {} } },
      updatedAt: 70,
    };
    const r = planStatDay(S, stat, ex, 9);
    expect(r.write!.patch).toMatchObject({ 'fields.cost': { total: 1.24 }, updatedAt: 70 });
    expect(Object.keys(r.write!.patch!)).not.toContain('fields');
    expect(r.correction).toBeNull();
  });
  it('equal → no write; a stale one is corrected', () => {
    const doc = planStatDay(S, stat, undefined, 9).write!.create!;
    expect(planStatDay(S, stat, doc, 9).write).toBeNull();
    const stale = { ...doc, fields: { cost: { total: 1, count: 1, tickets: {} } } };
    const r = planStatDay(S, stat, stale, 9);
    expect(r.write!.patch).toBeTruthy();
    expect(r.correction).toBeTruthy();
  });
});
