/**
 * HANDLER REGISTRY for every non-HTTP function.
 *
 * index.ts exports the whole deployed function surface (it is the only file
 * Firebase reads), but the handlers belong to other modules. So index.ts
 * exports one thin function per queue / trigger / schedule that dispatches to
 * whatever module registered itself here. A module registers by calling one
 * of these at import time, and modules are imported automatically (see
 * autoload.ts) from:
 *
 *   src/commands/  defineCommand(...)       → /api/{name}
 *   src/jobs/      defineTask / defineSchedule
 *   src/triggers/  defineTrigger
 *
 * So: create `src/jobs/deliver.ts` containing `defineTask('deliver', async (data) => …)`
 * and it runs — no edit to index.ts needed. A registration for a name that
 * already has one throws (two owners for one function is a bug).
 */
import type { CloudEvent } from 'firebase-functions/v2';
import type { Change, DocumentSnapshot, FirestoreEvent } from 'firebase-functions/v2/firestore';
import type {
  AuthBlockingEvent,
  beforeUserCreated,
  beforeUserSignedIn,
} from 'firebase-functions/v2/identity';
import type { ScheduledEvent } from 'firebase-functions/v2/scheduler';
import type { StorageObjectData } from 'firebase-functions/v2/storage';
import type { UserRecord } from 'firebase-admin/auth';
import type { QueueName, QueuePayloads } from '@tm/shared';

// The response types are not exported by firebase-functions; derive them from the handler signatures.
type BlockingResult<
  F extends (opts: never, handler: (e: AuthBlockingEvent) => unknown) => unknown,
> = Exclude<Awaited<ReturnType<Parameters<F>[1]>>, void>;
export type BeforeCreateResponse = BlockingResult<typeof beforeUserCreated>;
export type BeforeSignInResponse = BlockingResult<typeof beforeUserSignedIn>;

// ─── task queues ─────────────────────────────────────────────────────────────

/** Deployed function name per queue (`export` is a reserved word, so all are prefixed). */
export const QUEUE_FUNCTIONS: Record<QueueName, string> = {
  deliver: 'queueDeliver',
  webhooks: 'queueWebhooks',
  boardDelete: 'queueBoardDelete',
  artifactDelete: 'queueArtifactDelete',
  memoryDelete: 'queueMemoryDelete',
  export: 'queueExport',
  email: 'queueEmail',
};

export interface TaskMeta {
  /** Cloud Tasks task name / id when known. */
  id?: string;
  /** 0 on the first attempt. */
  retryCount: number;
}
export type TaskHandler<Q extends QueueName> = (
  data: QueuePayloads[Q],
  meta: TaskMeta,
) => Promise<void>;

const tasks = new Map<QueueName, TaskHandler<QueueName>>();

export function defineTask<Q extends QueueName>(queue: Q, handler: TaskHandler<Q>): TaskHandler<Q> {
  if (tasks.has(queue)) throw new Error(`Task handler for queue "${queue}" registered twice`);
  tasks.set(queue, handler as unknown as TaskHandler<QueueName>);
  return handler;
}
export function getTaskHandler<Q extends QueueName>(queue: Q): TaskHandler<Q> | undefined {
  return tasks.get(queue) as TaskHandler<Q> | undefined;
}

// ─── schedules ───────────────────────────────────────────────────────────────

/** Every schedule and its cron (app/backend.json services with trigger 'schedule'). */
export const SCHEDULES = {
  deadlineSweep: 'every 15 minutes',
  digestSend: '0 * * * *',
  housekeeping: '0 3 * * *',
  /**
   * Phase 3 (§L3): agent silence (5 min without a beat) and question expiry.
   *
   * It ran EVERY MINUTE — 1,440 cold-ish invocations a day to notice something
   * that is, by definition, five minutes old (§W). Every three minutes still
   * notices silence within 5–8 minutes, and the UI does not wait for it at
   * all: a card compares the last beat with the clock as it draws, so the dot
   * goes stale on screen with no function involved. The sweep exists only to
   * NOTIFY, which is not a thing to spend a third of the schedule budget on.
   */
  agentSilenceSweep: 'every 3 minutes',
} as const;
export type ScheduleName = keyof typeof SCHEDULES;
export type ScheduleHandler = (event: ScheduledEvent) => Promise<void>;

const schedules = new Map<ScheduleName, ScheduleHandler>();

export function defineSchedule(name: ScheduleName, handler: ScheduleHandler): ScheduleHandler {
  if (schedules.has(name)) throw new Error(`Schedule "${name}" registered twice`);
  schedules.set(name, handler);
  return handler;
}
export const getScheduleHandler = (name: ScheduleName) => schedules.get(name);

// ─── triggers ────────────────────────────────────────────────────────────────

export type TicketWrittenEvent = FirestoreEvent<
  Change<DocumentSnapshot> | undefined,
  { boardId: string; ticketId: string }
>;
export type MessageWrittenEvent = FirestoreEvent<
  Change<DocumentSnapshot> | undefined,
  { boardId: string; ticketId: string; messageId: string }
>;

/** The trigger surface; the doc paths / events live in index.ts. */
export interface TriggerHandlers {
  /** boards/{boardId}/tickets/{ticketId} onWrite. */
  onTicketWritten: (event: TicketWrittenEvent) => Promise<void>;
  /** boards/{b}/tickets/{t}/messages/{messageId} onWrite. */
  onMessageWritten: (event: MessageWrittenEvent) => Promise<void>;
  /** Storage onObjectFinalized (default bucket). */
  onAttachmentFinalized: (event: CloudEvent<StorageObjectData>) => Promise<void>;
  /** Blocking beforeUserCreated. */
  beforeUserCreated: (event: AuthBlockingEvent) => Promise<BeforeCreateResponse | void>;
  /** Blocking beforeUserSignedIn. */
  beforeUserSignedIn: (event: AuthBlockingEvent) => Promise<BeforeSignInResponse | void>;
  /** Auth onCreate (v1 — v2 has no non-blocking create event): users/{uid} doc etc. */
  onUserCreated: (user: UserRecord) => Promise<void>;
  /** Auth onDelete (v1): cleanup after an account is gone. */
  onUserDeleted: (user: UserRecord) => Promise<void>;
}
export type TriggerName = keyof TriggerHandlers;

const triggers = new Map<TriggerName, TriggerHandlers[TriggerName]>();

export function defineTrigger<T extends TriggerName>(
  name: T,
  handler: TriggerHandlers[T],
): TriggerHandlers[T] {
  if (triggers.has(name)) throw new Error(`Trigger "${name}" registered twice`);
  triggers.set(name, handler);
  return handler;
}
export function getTrigger<T extends TriggerName>(name: T): TriggerHandlers[T] | undefined {
  return triggers.get(name) as TriggerHandlers[T] | undefined;
}
