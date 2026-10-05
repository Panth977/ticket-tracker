/**
 * "A new version is ready" (docs/plan/agents.html § S).
 *
 * src/service-worker.ts deliberately does NOT skipWaiting on install: a new
 * build sits in `waiting` until you say so, so the running app is never swapped
 * out mid-sentence (half its lazy chunks would 404). We show the app's own
 * toast instead, and only on Reload do we tell the waiting worker to take over
 * and reload once it has.
 */
import { toast } from '$lib/ui';

const KEY = 'tm.update';
/** How often an open window asks whether a new build was deployed. */
export const UPDATE_CHECK_MS = 30 * 60_000;

/** The new worker took over: reload exactly once, whoever noticed first. */
let reloading = false;

function offer(waiting: ServiceWorker): void {
  toast.show({
    key: KEY, // one at a time, however many times we notice
    kind: 'info',
    message: 'A new version of TaskManager is ready',
    detail: 'Reload to pick it up — nothing you have typed is lost.',
    duration: 0, // sticky: this is not an interruption to time out
    action: {
      label: 'Reload',
      run: () => waiting.postMessage({ type: 'tm:skip-waiting' }),
    },
  });
}

/**
 * Watch this page's registration for a worker that is installed and waiting.
 * Idempotent per call; returns a teardown. Started by the account menu, which
 * mounts with the Shell on every signed-in screen.
 */
export function watchForUpdate(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  let stopped = false;
  const offs: (() => void)[] = [];

  const onController = () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', onController);
  offs.push(() => navigator.serviceWorker.removeEventListener('controllerchange', onController));

  void navigator.serviceWorker.ready.then((reg) => {
    if (stopped) return;
    // Already waiting when we arrived (a second tab installed it).
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

    const onUpdateFound = () => {
      const next = reg.installing;
      if (!next) return;
      const onState = () => {
        // `controller` is null on the very first install — that is not an
        // update, it is this build arriving for the first time.
        if (next.state === 'installed' && navigator.serviceWorker.controller) offer(next);
      };
      next.addEventListener('statechange', onState);
      offs.push(() => next.removeEventListener('statechange', onState));
    };
    reg.addEventListener('updatefound', onUpdateFound);
    offs.push(() => reg.removeEventListener('updatefound', onUpdateFound));

    // ASK, DON'T WAIT. The browser only re-checks the worker on a navigation,
    // and an installed app is one long-lived page that never navigates: left
    // open, it would run yesterday's build until it was quit. So check when
    // the window comes back to the front, and every half hour while it is.
    const check = () => {
      if (!stopped && document.visibilityState === 'visible') void reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    const timer = setInterval(check, UPDATE_CHECK_MS);
    offs.push(() => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      clearInterval(timer);
    });
  });

  return () => {
    stopped = true;
    toast.dismissKey(KEY);
    offs.forEach((off) => off());
  };
}
