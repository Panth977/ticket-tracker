/**
 * The app's command client and outbox, wired to Firebase Auth, the toast
 * stack and the 'Saving…' indicator. Import from here:
 *
 *   import { command, outbox, isAppError } from '$lib/api';
 *
 * Writes the user makes go through `outbox.queue(…)` (never blocks, retries,
 * survives offline); `command()` stays for reads-that-write (search keys,
 * exports) and flows that need the answer before going on (board create,
 * invites, tokens).
 */
import { auth } from '$lib/firebase/auth.svelte';
import { patchDoc } from '$lib/stores/overlay';
import { isOnline } from '$lib/stores/online';
import { toast } from '$lib/ui/toast.svelte';
import {
  createCommandClient,
  newClientId,
  OVERLAY_SETTLE_MS,
  type OptimisticSpec,
} from './command';
import { Outbox, type OutboxEntry } from './outbox.svelte';
import { createOutboxStorage } from './outboxStore';
import { saving } from './saving.svelte';

export const command = createCommandClient({
  getToken: (force) => auth.idToken(force),
  fetch: (...args) => fetch(...args),
  isOnline,
  toastError: (m, d) => toast.error(m, d),
  onSaving: (d) => saving.bump(d),
});

/** The outbox sends quietly: its own indicator and toasts say what is going on. */
const quiet = createCommandClient({
  getToken: (force) => auth.idToken(force),
  fetch: (...args) => fetch(...args),
  // The outbox checks online itself (and waits); let a request try anyway.
  isOnline: () => true,
  toastError: () => {},
  onSaving: () => {},
});

function applyOptimistic(spec: OptimisticSpec | undefined): () => void {
  if (!spec) return () => {};
  if (typeof spec === 'function') return spec();
  const list = Array.isArray(spec) ? spec : [spec];
  const undos = list.map((s) => patchDoc(s.path, s.patch));
  return () => undos.forEach((u) => u());
}

const toastKey = (id: string) => `outbox:${id}`;

export const outbox: Outbox = new Outbox({
  send: (name, input, clientId) =>
    (quiet as (n: string, i: unknown, o: object) => Promise<unknown>)(name, input, {
      toast: false,
      clientId,
    }),
  isOnline,
  storage: createOutboxStorage(),
  applyOptimistic,
  newId: newClientId,
  settleMs: OVERLAY_SETTLE_MS,
  navigate: (to, e) => {
    if (typeof document !== 'undefined') {
      // Already looking at that ticket (its drawer is open): stay, it highlights in place.
      if (
        e.ticketId &&
        e.kind === 'message' &&
        document.querySelector(`[data-open-ticket="${e.ticketId}"]`)
      )
        return;
      // Already there: the page picks the entry up (outbox.opening) without a reload of the route.
      const u = new URL(to, location.origin);
      if (u.pathname === location.pathname && (!u.search || u.search === location.search)) return;
    }
    void import('$app/navigation').then((m) => m.goto(to));
  },
  onFailure(e: OutboxEntry) {
    toast.show({
      key: toastKey(e.id),
      kind: 'error',
      duration: 0,
      message: `Couldn't ${e.label}`,
      detail: e.error,
      actions: [
        ...(e.openTo
          ? [{ label: 'Open', run: () => outbox.open(e.id) }]
          : [{ label: 'Retry', run: () => outbox.retry(e.id) }]),
        { label: 'Cancel', tone: 'muted' as const, run: () => void outbox.cancel(e.id) },
      ],
    });
  },
  onResolved(e: OutboxEntry) {
    toast.dismissKey(toastKey(e.id));
  },
});

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => outbox.resume());
}

export { saving };
export { createCommandClient, describeError, newClientId } from './command';
export type { CommandInput, CommandOptions, OptimisticSpec } from './command';
export { Outbox, MAX_RETRIES, isTransient } from './outbox.svelte';
export type { OutboxEntry, OutboxStatus, OutboxUpload, QueueOptions } from './outbox.svelte';
export { AppError, isAppError, type AppErrorCode } from '@tm/shared';
