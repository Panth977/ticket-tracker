/**
 * The backend emulator test harness. Import from here in any *.emu.test.ts:
 *
 *   import { setupEmulators, createUser, call, queue, devOutbox } from '../harness/index.js';
 *   setupEmulators();                       // assert reachability, reset ports per test
 *   const alice = await createUser({ name: 'Alice' });
 *   const res = await call(alice, 'boardCreate', { … });
 *   await queue().drain();                  // run enqueued tasks through their handlers
 *
 * Tests run in-process against the Auth + Firestore emulators (root
 * `pnpm test:emu` boots them). Test files run in parallel on one emulator:
 * use uniq() ids rather than wiping the database.
 */
import './env.js';
import type { Query } from 'firebase-admin/firestore';
import { afterEach, beforeAll } from 'vitest';
import {
  ports,
  resetPorts,
  setPorts,
  DEV_OUTBOX,
  type DevOutbox,
  type MemoryQueue,
} from '../../src/adapters/index.js';
import { db } from '../../src/runtime/firebase.js';
import { assertEmulators } from './emulators.js';

export * from './env.js';
export * from './emulators.js';
export * from './users.js';
export * from './call.js';
export { ports, setPorts, resetPorts };
export { fixedClock, seqIds, memorySearch, memoryQueue } from '../../src/adapters/index.js';

/** Register the standard hooks: emulators reachable before, fresh ports after each test. */
export function setupEmulators(): void {
  beforeAll(assertEmulators);
  afterEach(() => resetPorts());
}

/** The in-memory task queue the in-process api enqueues to (TM_QUEUE=memory). */
export function queue(): MemoryQueue {
  const q = ports().queue as Partial<MemoryQueue>;
  if (typeof q.drain !== 'function')
    throw new Error('queue(): ports().queue is not the memory queue (TM_QUEUE?)');
  return q as MemoryQueue;
}

/** Items the dev fakes recorded (mail / push / whatsapp), oldest first, optionally filtered. */
export async function devOutbox<T = Record<string, unknown>>(
  box: DevOutbox,
  where?: { field: string; equals: unknown },
): Promise<(T & { id: string })[]> {
  let q: Query = db().collection(DEV_OUTBOX[box]);
  if (where) q = q.where(where.field, '==', where.equals);
  const snap = await q.get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as T & { at: number }) }))
    .sort((a, b) => (a as { at: number }).at - (b as { at: number }).at);
}
