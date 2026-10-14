/**
 * TASK QUEUES AND SCHEDULES WITHOUT CLOUD TASKS / CLOUD SCHEDULER — the VM's
 * own, in-process, persisted in the database port (so they survive a
 * restart, and work on any store).
 *
 * QUEUE (TM_QUEUE=local, the VM default). A task is a document
 *   _tasks/{id}   { queue, payload, state: queued | done | dead, runAt,
 *                   attempts, lockedUntil, createdAt, doneAt?, lastError? }
 * A named task's id is derived from (queue, name), and create() refuses a
 * second one — the same dedupe Cloud Tasks gives a task name. A finished
 * task stays (state 'done') for a day, so a late duplicate is still refused;
 * housekeeping prunes it after that.
 *
 * RUNNER. Every second it claims due tasks (a transaction sets lockedUntil,
 * so two servers never run one task), runs the handler registered with
 * defineTask, and on failure retries with the queue's backoff (QUEUE_POLICY —
 * the same numbers the Firebase deploy gives Cloud Tasks) until maxAttempts,
 * then marks it 'dead'. A crashed run is retried once its lock runs out.
 *
 * SCHEDULER. Every minute (UTC) each schedule in SCHEDULES whose cron
 * matches runs once: a transaction on _cron/{name} records the minute, so
 * with several servers exactly one runs it.
 */
import type { EnqueueOptions, QueueName, QueuePayloads, TaskQueue } from '@tm/shared';
import { db } from '../db/index.js';
import { taskId } from '../adapters/taskId.js';
import { parseSchedule } from './cron.js';
import {
  getScheduleHandler,
  getTaskHandler,
  QUEUE_POLICY,
  SCHEDULES,
  type ScheduleName,
} from './functions.js';

export const TASKS = '_tasks';
export const CRON = '_cron';
/** How long a claimed task is ours before another runner may take it (the Firebase timeout). */
const LOCK_MS = 540_000;
/** Done tasks are kept this long for name dedupe. */
export const DONE_TTL_MS = 24 * 3600_000;

interface TaskDoc {
  queue: QueueName;
  payload: unknown;
  name: string | null;
  state: 'queued' | 'done' | 'dead';
  runAt: number;
  attempts: number;
  lockedUntil: number;
  createdAt: number;
  doneAt?: number;
  lastError?: string;
}

export function localQueue(now: () => number = Date.now): TaskQueue {
  return {
    async enqueue<Q extends QueueName>(
      queue: Q,
      payload: QueuePayloads[Q],
      opts: EnqueueOptions = {},
    ) {
      const col = db().collection(TASKS);
      const ref = opts.name ? col.doc(`${queue}__${taskId(opts.name)}`) : col.doc();
      const t = now();
      const doc: TaskDoc = {
        queue,
        // Tasks cross a JSON boundary in Cloud Tasks; do the same here.
        payload: JSON.parse(JSON.stringify(payload)),
        name: opts.name ?? null,
        state: 'queued',
        runAt: t + (opts.delaySeconds ?? 0) * 1000,
        attempts: 0,
        lockedUntil: 0,
        createdAt: t,
      };
      try {
        await ref.create(doc);
      } catch (e) {
        if ((e as { code?: number }).code === 6) return; // the name dedupe
        throw e;
      }
    },
  };
}

/** Backoff before attempt `attempts + 1`, as Cloud Tasks computes it. */
export function backoffMs(queue: QueueName, attempts: number): number {
  const p = QUEUE_POLICY[queue];
  const min = p.minBackoffSeconds * 1000;
  const max = (p.maxBackoffSeconds ?? 3600) * 1000;
  const doublings = Math.min(Math.max(0, attempts - 1), p.maxDoublings ?? 16);
  return Math.min(max, min * 2 ** doublings);
}

/** Claim and run every due task once. Returns how many ran (tests call it directly). */
export async function runDueTasks(now: () => number = Date.now, max = 20): Promise<number> {
  const due = await db()
    .collection(TASKS)
    .where('state', '==', 'queued')
    .where('runAt', '<=', now())
    .orderBy('runAt')
    .limit(max)
    .get();
  let ran = 0;
  for (const snap of due.docs) {
    const ref = snap.ref;
    const claimed = await db().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const d = cur.data() as TaskDoc | undefined;
      if (!d || d.state !== 'queued' || d.runAt > now() || d.lockedUntil > now()) return undefined;
      tx.update(ref, { lockedUntil: now() + LOCK_MS });
      return d;
    });
    if (!claimed) continue;
    const handler = getTaskHandler(claimed.queue);
    if (!handler) {
      // No handler in this build: leave it for one that has.
      await ref.update({ lockedUntil: 0 });
      continue;
    }
    ran++;
    try {
      await handler(claimed.payload as QueuePayloads[QueueName], {
        retryCount: claimed.attempts,
        id: ref.id,
      });
      await ref.update({ state: 'done', doneAt: now(), lockedUntil: 0 });
    } catch (e) {
      const attempts = claimed.attempts + 1;
      const dead = attempts >= QUEUE_POLICY[claimed.queue].maxAttempts;
      console.error(`[jobs] ${claimed.queue} ${ref.id} failed (attempt ${attempts})`, e);
      await ref.update({
        attempts,
        lockedUntil: 0,
        lastError: String((e as Error)?.message ?? e).slice(0, 1000),
        ...(dead
          ? { state: 'dead', doneAt: now() }
          : { runAt: now() + backoffMs(claimed.queue, attempts) }),
      });
    }
  }
  return ran;
}

/** Drop finished tasks older than the dedupe window (housekeeping). */
export async function pruneTasks(now: number = Date.now()): Promise<number> {
  const old = await db()
    .collection(TASKS)
    .where('doneAt', '<', now - DONE_TTL_MS)
    .limit(500)
    .get();
  const batch = db().batch();
  old.docs.forEach((d) => batch.delete(d.ref));
  if (!old.empty) await batch.commit();
  return old.size;
}

/** Run the schedules that fire at this minute (each once, across every server). */
export async function runDueSchedules(at: Date = new Date()): Promise<ScheduleName[]> {
  const minute = Math.floor(at.getTime() / 60_000);
  const ran: ScheduleName[] = [];
  for (const [name, spec] of Object.entries(SCHEDULES) as [ScheduleName, string][]) {
    if (!parseSchedule(spec).matches(at)) continue;
    const handler = getScheduleHandler(name);
    if (!handler) continue;
    const ref = db().collection(CRON).doc(name);
    const mine = await db().runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data() as { minute?: number } | undefined;
      if (cur?.minute === minute) return false;
      tx.set(ref, { minute, startedAt: Date.now() }, { merge: true });
      return true;
    });
    if (!mine) continue;
    ran.push(name);
    try {
      await handler({
        scheduleTime: new Date(minute * 60_000).toISOString(),
        jobName: name,
      } as never);
      await ref.set({ finishedAt: Date.now(), lastError: null }, { merge: true });
    } catch (e) {
      console.error(`[schedule] ${name} failed`, e);
      await ref.set(
        { finishedAt: Date.now(), lastError: String((e as Error)?.message ?? e).slice(0, 1000) },
        { merge: true },
      );
    }
  }
  return ran;
}

/** Start the runner (every second) and the scheduler (every minute). Returns stop(). */
export function startLocalJobs(): () => void {
  let busy = false;
  const tasks = setInterval(() => {
    if (busy) return;
    busy = true;
    runDueTasks()
      .catch((e) => console.error('[jobs] runner failed', e))
      .finally(() => (busy = false));
  }, 1000);
  let timer: NodeJS.Timeout | undefined;
  const nextMinute = () => {
    timer = setTimeout(
      () => {
        void runDueSchedules(new Date()).catch((e) => console.error('[schedule] tick failed', e));
        nextMinute();
      },
      60_000 - (Date.now() % 60_000) + 50,
    );
  };
  nextMinute();
  return () => {
    clearInterval(tasks);
    if (timer) clearTimeout(timer);
  };
}
