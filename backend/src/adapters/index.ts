/**
 * THE PORTS — every external dependency a command may reach, chosen once per
 * process from the environment (real client when its env vars are set, dev
 * fake otherwise). Commands call `ports().email.send(…)`; tests call
 * `setPorts({ clock: fixedClock(…) })` and `resetPorts()`.
 *
 * notify / emitWebhook are NOT built here: they are imported from
 * '../notify/index.js' and '../platform/emit.js' (owned by the notify and
 * platform steps) and exposed on Ports for doors that want one bag.
 */
import type { Ports } from '@tm/shared';
import { notify } from '../notify/index.js';
import { emitWebhook } from '../platform/emit.js';
import { randomIds, systemClock } from './clock.js';
import { createEmail } from './email.js';
import { adminFiles } from './files.js';
import { createPush } from './push.js';
import { createQueue } from './queue.js';
import { createSearch } from './search.js';
import { createWhatsapp } from './whatsapp.js';

export * from './clock.js';
export * from './dev.js';
export * from './email.js';
export * from './files.js';
export * from './notConfigured.js';
export * from './push.js';
export * from './queue.js';
export * from './search.js';
export * from './whatsapp.js';

function build(): Ports {
  return {
    email: createEmail(),
    push: createPush(),
    whatsapp: createWhatsapp(),
    search: createSearch(),
    queue: createQueue(),
    clock: systemClock(),
    ids: randomIds(),
    files: adminFiles(),
    // build() runs lazily (first ports() call), after every module has loaded,
    // so the import cycle notify → adapters → notify is harmless.
    notify,
    emitWebhook,
  };
}

let current: Ports | undefined;

export function ports(): Ports {
  return (current ??= build());
}

/** Replace some ports (tests). Returns the previous full set. */
export function setPorts(patch: Partial<Ports>): Ports {
  const prev = ports();
  current = { ...prev, ...patch };
  return prev;
}

/** Back to env-selected defaults (fresh fakes: empty memory queue / index). */
export function resetPorts(): void {
  current = undefined;
}
