/**
 * The VM's own task queue + scheduler (runtime/localJobs.ts) on the SQLite
 * store, in memory. Cloud Tasks / Cloud Scheduler are the reference for the
 * behaviour: name dedupe, retry with the queue's backoff, a dead letter
 * after maxAttempts, each schedule once per minute.
 */
process.env.TM_DB = 'sqlite';
process.env.TM_DB_DIR = ':memory:';

import { describe, expect, it } from 'vitest';

const { parseSchedule } = await import('../../src/runtime/cron.js');
const { defineSchedule, defineTask, QUEUE_POLICY, SCHEDULES } =
  await import('../../src/runtime/functions.js');
const { backoffMs, localQueue, pruneTasks, runDueSchedules, runDueTasks, TASKS, DONE_TTL_MS } =
  await import('../../src/runtime/localJobs.js');
const { db } = await import('../../src/db/index.js');

describe('cron', () => {
  const at = (iso: string) => new Date(iso);
  it('every N minutes runs on the UTC grid', () => {
    const s = parseSchedule('every 15 minutes');
    expect(s.matches(at('2026-10-14T10:00:00Z'))).toBe(true);
    expect(s.matches(at('2026-10-14T10:45:30Z'))).toBe(true);
    expect(s.matches(at('2026-10-14T10:07:00Z'))).toBe(false);
    expect(parseSchedule('every 3 minutes').matches(at('2026-10-14T00:03:00Z'))).toBe(true);
  });
  it('unix cron fields', () => {
    expect(parseSchedule('0 * * * *').matches(at('2026-10-14T05:00:10Z'))).toBe(true);
    expect(parseSchedule('0 * * * *').matches(at('2026-10-14T05:01:00Z'))).toBe(false);
    expect(parseSchedule('0 3 * * *').matches(at('2026-10-14T03:00:00Z'))).toBe(true);
    expect(parseSchedule('0 3 * * *').matches(at('2026-10-14T04:00:00Z'))).toBe(false);
    expect(parseSchedule('*/10 9-17 * * 1-5').matches(at('2026-10-14T09:20:00Z'))).toBe(true); // a Wednesday
    expect(parseSchedule('*/10 9-17 * * 1-5').matches(at('2026-10-18T09:20:00Z'))).toBe(false); // a Sunday
    expect(() => parseSchedule('61 * * * *')).toThrow();
  });
  it('every schedule the app declares parses', () => {
    for (const spec of Object.values(SCHEDULES)) expect(() => parseSchedule(spec)).not.toThrow();
  });
});

describe('local task queue', () => {
  let clock = Date.UTC(2026, 9, 14, 12);
  const now = () => clock;
  const seen: { payload: unknown; retryCount: number }[] = [];
  let failFor = 0;
  defineTask('export', async (payload, meta) => {
    seen.push({ payload, retryCount: meta.retryCount });
    if (failFor > 0) {
      failFor--;
      throw new Error('boom');
    }
  });

  it('runs a task once; a named task is deduplicated', async () => {
    seen.length = 0;
    const q = localQueue(now);
    await q.enqueue('export', { uid: 'u1' } as never, { name: 'once' });
    await q.enqueue('export', { uid: 'u1' } as never, { name: 'once' });
    expect(await runDueTasks(now)).toBe(1);
    expect(await runDueTasks(now)).toBe(0);
    expect(seen).toEqual([{ payload: { uid: 'u1' }, retryCount: 0 }]);
    // Still refused after it ran (the dedupe window).
    await q.enqueue('export', { uid: 'u1' } as never, { name: 'once' });
    expect(await runDueTasks(now)).toBe(0);
  });

  it('honours delaySeconds', async () => {
    seen.length = 0;
    await localQueue(now).enqueue('export', { uid: 'later' } as never, { delaySeconds: 60 });
    expect(await runDueTasks(now)).toBe(0);
    clock += 61_000;
    expect(await runDueTasks(now)).toBe(1);
  });

  it('retries with the queue backoff, then dead-letters after maxAttempts', async () => {
    seen.length = 0;
    failFor = 99;
    await localQueue(now).enqueue('export', { uid: 'bad' } as never);
    const max = QUEUE_POLICY.export.maxAttempts;
    for (let i = 0; i < max; i++) {
      expect(await runDueTasks(now)).toBe(1);
      clock += backoffMs('export', i + 1) + 1;
    }
    expect(await runDueTasks(now)).toBe(0);
    expect(seen.map((s) => s.retryCount)).toEqual(Array.from({ length: max }, (_, i) => i));
    const dead = await db().collection(TASKS).where('state', '==', 'dead').get();
    expect(dead.size).toBe(1);
    expect(dead.docs[0]!.data().lastError).toBe('boom');
    failFor = 0;
  });

  it('backoff doubles from the minimum, capped (webhooks: 60s … 12h, 5 doublings)', () => {
    expect(backoffMs('webhooks', 1)).toBe(60_000);
    expect(backoffMs('webhooks', 2)).toBe(120_000);
    expect(backoffMs('webhooks', 6)).toBe(60_000 * 32);
    expect(backoffMs('webhooks', 9)).toBe(60_000 * 32);
    expect(backoffMs('deliver', 20)).toBe(3600_000);
  });

  it('pruneTasks drops finished tasks after the dedupe window', async () => {
    const before = (await db().collection(TASKS).get()).size;
    expect(await pruneTasks(clock + DONE_TTL_MS + 1)).toBeGreaterThan(0);
    expect((await db().collection(TASKS).get()).size).toBeLessThan(before);
  });
});

describe('local scheduler', () => {
  const runs: string[] = [];
  defineSchedule('agentSilenceSweep', async (e) => {
    runs.push((e as unknown as { scheduleTime: string }).scheduleTime);
  });

  it('runs a due schedule once per minute, not when it is not due', async () => {
    const t = new Date('2026-10-14T10:03:20Z'); // every 3 minutes → due
    expect(await runDueSchedules(t)).toContain('agentSilenceSweep');
    expect(await runDueSchedules(new Date('2026-10-14T10:03:50Z'))).not.toContain(
      'agentSilenceSweep',
    );
    expect(await runDueSchedules(new Date('2026-10-14T10:04:00Z'))).not.toContain(
      'agentSilenceSweep',
    );
    expect(runs).toEqual(['2026-10-14T10:03:00.000Z']);
  });
});
