/**
 * THE DEPLOYED FUNCTION SURFACE — the only module Firebase reads.
 *
 *   api                    HTTPS: hono app, every door (/api, /v1, /mcp, /oauth, /hooks, /.well-known, /ics)
 *   queue*                 Cloud Tasks (onTaskDispatched), one per QueueName
 *   deadlineSweep …        Cloud Scheduler
 *   onTicketWritten …      Firestore / Storage / Auth triggers
 *
 * Every export is built with IceBase's wrappers (@panth977/icebase-server/functions): on
 * Firebase they are firebase-functions' own; the IceBase server runs the same exports.
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
import { setGlobalOptions } from 'firebase-functions/v2';
import type { Request, TaskQueueOptions } from 'firebase-functions/v2/tasks';
import {
  beforeUserCreated,
  beforeUserSignedIn,
  onDocumentWritten,
  onObjectFinalized,
  onRequest,
  onSchedule,
  onTaskDispatched,
  onUserCreated as onAuthUserCreated,
  onUserDeleted as onAuthUserDeleted,
} from '@panth977/icebase-server/functions';
import type { QueueName, QueuePayloads } from '@tm/shared';
import { createApp } from './http/app.js';
import { autoloadSync } from './runtime/autoload.js';
import { DOC_TRIGGERS } from './runtime/localTriggers.js';
import { boundSecrets, region, withServerSecrets } from './runtime/deploy.js';
import {
  getScheduleHandler,
  getTaskHandler,
  getTrigger,
  QUEUE_POLICY,
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

// Built on the first request (createApp reuses the modules loaded above). Fetch-style:
// IceBase hands hono a Request built from Firebase's pre-parsed req.rawBody.
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const ensureSecrets = withServerSecrets(() => undefined);

export const api = onRequest(
  // NOT cpu < 1 (§W): Cloud Run refuses a fractional CPU together with
  // concurrency > 1, and one instance serving 80 concurrent calls is far
  // cheaper than 80 instances at half a core. Concurrency IS the saving here.
  { invoker: 'public', concurrency: 80, memory: '512MiB', timeoutSeconds: 60 },
  async (req: globalThis.Request) => {
    await ensureSecrets();
    app ??= await createApp();
    return app.fetch(req);
  },
);

// ─── task queues ─────────────────────────────────────────────────────────────

/** Cloud Tasks options per queue: the shared retry / rate policy plus Cloud-only sizing. */
const CLOUD_ONLY: Partial<Record<QueueName, Pick<TaskQueueOptions, 'timeoutSeconds' | 'memory'>>> =
  {
    boardDelete: { timeoutSeconds: 540 },
    artifactDelete: { timeoutSeconds: 540 },
    bucketDelete: { timeoutSeconds: 540 },
    bucketStorageMove: { timeoutSeconds: 540, memory: '1GiB' },
    entityStorageMove: { timeoutSeconds: 540, memory: '1GiB' },
    export: { timeoutSeconds: 540, memory: '1GiB' },
  };
function queueOptions(queue: QueueName): TaskQueueOptions {
  const { maxDispatchesPerSecond, ...retryConfig } = QUEUE_POLICY[queue];
  return {
    retryConfig,
    ...(maxDispatchesPerSecond ? { rateLimits: { maxDispatchesPerSecond } } : {}),
    ...CLOUD_ONLY[queue],
  };
}

function queueFn<Q extends QueueName>(queue: Q) {
  const handler = getTaskHandler(queue);
  if (!handler) return undefined;
  return onTaskDispatched(
    queueOptions(queue),
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
export const queueBucketDelete = queueFn('bucketDelete');
export const queueBucketStorageMove = queueFn('bucketStorageMove');
export const queueEntityStorageMove = queueFn('entityStorageMove');
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
export const stageRules = scheduleFn('stageRules');
// Phase 3 (§L3): agent silence + question expiry, every minute.
export const agentSilenceSweep = scheduleFn('agentSilenceSweep');

// ─── triggers ────────────────────────────────────────────────────────────────

/** Auth onCreate / onDelete are firebase-functions v1: the same region and secrets, given here. */
const V1 = { region: REGION, ...(SECRETS.length ? { secrets: SECRETS } : {}) };

function trig<T extends TriggerName>(name: T, wrap: (h: TriggerHandlers[T]) => unknown) {
  const h = getTrigger(name);
  return h
    ? wrap(withServerSecrets(h as (...a: unknown[]) => unknown) as TriggerHandlers[T])
    : undefined;
}

export const onTicketWritten = trig('onTicketWritten', (h) =>
  onDocumentWritten(DOC_TRIGGERS.onTicketWritten, h),
);
export const onMessageWritten = trig('onMessageWritten', (h) =>
  onDocumentWritten(DOC_TRIGGERS.onMessageWritten, h),
);
export const onAttachmentFinalized = trig('onAttachmentFinalized', (h) =>
  onObjectFinalized({ memory: '1GiB' }, h),
);
export const beforeCreate = trig('beforeUserCreated', (h) => beforeUserCreated(h));
export const beforeSignIn = trig('beforeUserSignedIn', (h) => beforeUserSignedIn(h));
export const onUserCreated = trig('onUserCreated', (h) =>
  onAuthUserCreated(V1, (u) => h(u as never)),
);
export const onUserDeleted = trig('onUserDeleted', (h) =>
  onAuthUserDeleted(V1, (u) => h(u as never)),
);
