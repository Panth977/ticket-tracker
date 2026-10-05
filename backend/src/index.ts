/**
 * THE DEPLOYED FUNCTION SURFACE — the only module Firebase reads.
 *
 *   api                    HTTPS: hono app, every door (/api, /v1, /mcp, /oauth, /hooks, /.well-known, /ics)
 *   queue*                 Cloud Tasks (onTaskDispatched), one per QueueName
 *   deadlineSweep …        Cloud Scheduler
 *   onTicketWritten …      Firestore / Storage / Auth triggers
 *
 * Handlers are NOT written here. Modules in src/commands, src/jobs,
 * src/triggers and src/doors register themselves (see runtime/functions.ts);
 * autoloadSync() imports them all before the exports below are computed.
 * (Synchronously: the Functions runtime require()s this module, so there
 * must be no top-level await anywhere in the graph.)
 *
 * A queue / schedule / trigger with no registered handler is exported as
 * `undefined`, which Firebase skips — so nothing is deployed (or run in the
 * emulator) until its owner lands the handler.
 */
import { getRequestListener } from '@hono/node-server';
import * as functionsV1 from 'firebase-functions/v1';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { beforeUserCreated, beforeUserSignedIn } from 'firebase-functions/v2/identity';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { onTaskDispatched, type Request, type TaskQueueOptions } from 'firebase-functions/v2/tasks';
import type { QueueName, QueuePayloads } from '@tm/shared';
import { createApp } from './http/app.js';
import { autoloadSync } from './runtime/autoload.js';
import { boundSecrets, region, withServerSecrets } from './runtime/deploy.js';
import {
  getScheduleHandler,
  getTaskHandler,
  getTrigger,
  SCHEDULES,
  type ScheduleName,
  type TriggerHandlers,
  type TriggerName,
} from './runtime/functions.js';

// TM_REGION (backend/.env.<projectId> in production; us-central1 under the
// emulators) and the optional Secret Manager bindings (TM_SECRETS) — see
// runtime/deploy.ts. Every export below inherits both.
const REGION = region();
// process.env.TM_* are written out literally so the deploy bundle can inline them
// (esbuild define): the CLI's deploy-time analysis does not see the .env file.
const SECRETS = boundSecrets({ TM_SECRETS: process.env.TM_SECRETS });
setGlobalOptions({
  region: REGION,
  maxInstances: 20,
  ...(SECRETS.length ? { secrets: SECRETS } : {}),
});

// ─── HTTPS ───────────────────────────────────────────────────────────────────

autoloadSync();

// Built on the first request (createApp reuses the modules loaded above).
// @hono/node-server reads Firebase's pre-parsed req.rawBody, so bodies survive express.
let listener: ReturnType<typeof getRequestListener> | undefined;
const ensureSecrets = withServerSecrets(() => undefined);

export const api = onRequest(
  // NOT cpu < 1 (§W): Cloud Run refuses a fractional CPU together with
  // concurrency > 1, and one instance serving 80 concurrent calls is far
  // cheaper than 80 instances at half a core. Concurrency IS the saving here.
  { invoker: 'public', concurrency: 80, memory: '512MiB', timeoutSeconds: 60 },
  async (req, res) => {
    await ensureSecrets();
    listener ??= getRequestListener((await createApp()).fetch);
    await listener(req, res);
  },
);

// ─── task queues ─────────────────────────────────────────────────────────────

/** Retry / rate policy per queue (platform/backend.json: webhooks 500/s, 8 attempts over ~24h). */
const QUEUE_OPTIONS: Record<QueueName, TaskQueueOptions> = {
  deliver: {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 3600 },
    rateLimits: { maxDispatchesPerSecond: 200 },
  },
  webhooks: {
    retryConfig: {
      maxAttempts: 8,
      minBackoffSeconds: 60,
      maxBackoffSeconds: 12 * 3600,
      maxDoublings: 5,
    },
    rateLimits: { maxDispatchesPerSecond: 500 },
  },
  boardDelete: { retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 }, timeoutSeconds: 540 },
  // Artifacts (artifacts.html §G): the same shape of job — a recursive delete of unknown size.
  artifactDelete: { retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 }, timeoutSeconds: 540 },
  // Memory (memory.html §G): the same shape again.
  memoryDelete: { retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 }, timeoutSeconds: 540 },
  export: {
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  email: {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 },
    rateLimits: { maxDispatchesPerSecond: 50 },
  },
};

function queueFn<Q extends QueueName>(queue: Q) {
  const handler = getTaskHandler(queue);
  if (!handler) return undefined;
  return onTaskDispatched(
    QUEUE_OPTIONS[queue],
    withServerSecrets((req: Request<QueuePayloads[Q]>) =>
      handler(req.data, { id: req.id, retryCount: req.retryCount ?? 0 }),
    ),
  );
}

// Names must match runtime/functions.ts QUEUE_FUNCTIONS.
export const queueDeliver = queueFn('deliver');
export const queueWebhooks = queueFn('webhooks');
export const queueBoardDelete = queueFn('boardDelete');
export const queueArtifactDelete = queueFn('artifactDelete');
export const queueMemoryDelete = queueFn('memoryDelete');
export const queueExport = queueFn('export');
export const queueEmail = queueFn('email');

// ─── schedules ───────────────────────────────────────────────────────────────

function scheduleFn(name: ScheduleName) {
  const handler = getScheduleHandler(name);
  if (!handler) return undefined;
  return onSchedule(
    { schedule: SCHEDULES[name], timeZone: 'UTC', timeoutSeconds: 540 },
    withServerSecrets(handler),
  );
}

export const deadlineSweep = scheduleFn('deadlineSweep');
export const digestSend = scheduleFn('digestSend');
export const housekeeping = scheduleFn('housekeeping');
// Phase 3 (§L3): agent silence + question expiry, every minute.
export const agentSilenceSweep = scheduleFn('agentSilenceSweep');

// ─── triggers ────────────────────────────────────────────────────────────────

/** v1 builder (auth onCreate / onDelete) with the same region and secrets. */
const v1 = () => {
  const b = functionsV1.region(REGION);
  return SECRETS.length ? b.runWith({ secrets: SECRETS }) : b;
};

function trig<T extends TriggerName>(name: T, wrap: (h: TriggerHandlers[T]) => unknown) {
  const h = getTrigger(name);
  return h
    ? wrap(withServerSecrets(h as (...a: unknown[]) => unknown) as TriggerHandlers[T])
    : undefined;
}

export const onTicketWritten = trig('onTicketWritten', (h) =>
  onDocumentWritten('boards/{boardId}/tickets/{ticketId}', h),
);
export const onMessageWritten = trig('onMessageWritten', (h) =>
  onDocumentWritten('boards/{boardId}/tickets/{ticketId}/messages/{messageId}', h),
);
export const onAttachmentFinalized = trig('onAttachmentFinalized', (h) =>
  onObjectFinalized({ memory: '1GiB' }, h),
);
export const beforeCreate = trig('beforeUserCreated', (h) => beforeUserCreated(h));
export const beforeSignIn = trig('beforeUserSignedIn', (h) => beforeUserSignedIn(h));
export const onUserCreated = trig('onUserCreated', (h) =>
  v1()
    .auth.user()
    .onCreate((u) => h(u)),
);
export const onUserDeleted = trig('onUserDeleted', (h) =>
  v1()
    .auth.user()
    .onDelete((u) => h(u)),
);
