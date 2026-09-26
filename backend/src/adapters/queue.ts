/**
 * TaskQueue: Cloud Tasks through the Admin SDK's taskQueue(), targeting the
 * onTaskDispatched functions index.ts exports (QUEUE_FUNCTIONS). The Admin
 * SDK honours CLOUD_TASKS_EMULATOR_HOST, so under `firebase emulators:start`
 * (functions + tasks) enqueued tasks really run.
 *
 * Mode (env TM_QUEUE overrides):
 *   cloud   production, or the functions emulator with the tasks emulator
 *   memory  everything else under the emulators (vitest runs the api
 *           in-process, with no functions emulator to dispatch to): tasks
 *           are held in memory and run by `drain()` through the handlers
 *           registered with defineTask — so tests see the same code path.
 *
 * Task names DEDUPLICATE in both modes. Cloud Tasks ids allow only
 * [A-Za-z0-9_-]; names like `uid:group:minute` are mapped to a safe id.
 */
import { createHash } from 'node:crypto';
import type { EnqueueOptions, QueueName, QueuePayloads, TaskQueue } from '@tm/shared';
import { functionsAdmin, isEmulated } from '../runtime/firebase.js';
import { region } from '../runtime/deploy.js';
import { getTaskHandler, QUEUE_FUNCTIONS } from '../runtime/functions.js';

/** Where the queue functions live (TM_REGION — see runtime/deploy.ts). */
export const LOCATION = region();

/** A Cloud Tasks-safe id for a logical task name (stable: same name → same id). */
export function taskId(name: string): string {
  if (/^[A-Za-z0-9_-]{1,400}$/.test(name)) return name;
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return `${safe}-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
}

export function cloudQueue(): TaskQueue {
  return {
    async enqueue(queue, payload, opts = {}) {
      const q = functionsAdmin().taskQueue(
        `locations/${region()}/functions/${QUEUE_FUNCTIONS[queue]}`,
      );
      try {
        await q.enqueue(payload as Record<string, unknown>, {
          ...(opts.name ? { id: taskId(opts.name) } : {}),
          ...(opts.delaySeconds ? { scheduleDelaySeconds: opts.delaySeconds } : {}),
        });
      } catch (e) {
        // A duplicate name is the dedupe working, not a failure.
        if ((e as { code?: string }).code?.endsWith('task-already-exists')) return;
        throw e;
      }
    },
  };
}

export interface MemoryTask<Q extends QueueName = QueueName> {
  queue: Q;
  payload: QueuePayloads[Q];
  opts: EnqueueOptions;
}

export interface MemoryQueue extends TaskQueue {
  /** Tasks enqueued and not yet drained. */
  pending(): MemoryTask[];
  /** Everything ever enqueued (dedupe-dropped ones excluded), for assertions. */
  history(): MemoryTask[];
  /**
   * Run pending tasks (and any they enqueue) through their registered
   * handlers, ignoring delays. Tasks for queues without a handler stay
   * pending. Returns how many ran.
   */
  drain(opts?: { queue?: QueueName; max?: number }): Promise<number>;
  clear(): void;
}

export function memoryQueue(): MemoryQueue {
  let queued: MemoryTask[] = [];
  let log: MemoryTask[] = [];
  const seen = new Set<string>();
  return {
    async enqueue(queue, payload, opts = {}) {
      if (opts.name) {
        const key = `${queue}/${opts.name}`;
        if (seen.has(key)) return;
        seen.add(key);
      }
      // Tasks cross a JSON boundary in Cloud Tasks; do the same here.
      const t = { queue, payload: JSON.parse(JSON.stringify(payload)), opts } as MemoryTask;
      queued.push(t);
      log.push(t);
    },
    pending: () => [...queued],
    history: () => [...log],
    async drain({ queue, max = 1000 } = {}) {
      let ran = 0;
      for (;;) {
        const i = queued.findIndex((t) => (!queue || t.queue === queue) && getTaskHandler(t.queue));
        if (i < 0 || ran >= max) return ran;
        const [t] = queued.splice(i, 1);
        await getTaskHandler(t!.queue)!(t!.payload, {
          retryCount: 0,
          ...(t!.opts.name ? { id: t!.opts.name } : {}),
        });
        ran++;
      }
    },
    clear() {
      queued = [];
      log = [];
      seen.clear();
    },
  };
}

export function createQueue(): TaskQueue {
  const mode = process.env.TM_QUEUE;
  if (mode === 'memory') return memoryQueue();
  if (mode === 'cloud') return cloudQueue();
  return !isEmulated() || process.env.CLOUD_TASKS_EMULATOR_HOST ? cloudQueue() : memoryQueue();
}
