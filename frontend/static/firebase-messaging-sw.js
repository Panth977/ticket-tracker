/* eslint-disable */
/**
 * Push and notification-click — THE one implementation, at FCM's conventional
 * path so nothing has to be told where it lives (docs/plan/agents.html § S).
 *
 * It is written to run in two ways from this single copy:
 *
 *   IMPORTED   src/service-worker.ts pulls it in with importScripts() (a built
 *              service worker is a classic script), so the app's worker — the
 *              ONE registration that owns scope '/' — handles push itself.
 *              Two workers at one scope used to fight over the registration;
 *              now there is only this file's code inside that worker.
 *   REGISTERED as its own worker at '/firebase-cloud-messaging-push-scope',
 *              the fallback lib/notifications/push.svelte.ts uses only when
 *              there is no worker at '/' at all.
 *
 * Deliberately no Firebase SDK and no importScripts of one: the payload FCM
 * delivers is JSON we can show ourselves ({ notification, data, fcmOptions }),
 * and the dev fake sends { title, body, url }. Adding the SDK here would mean
 * shipping a second copy of Firebase into the worker for nothing.
 *
 * Because it may be imported, it must not install install/activate/fetch
 * handlers or touch caches — the host worker owns those.
 */

/** Only same-origin paths: a payload can never send the click elsewhere. */
function tmSafePath(raw) {
  if (!raw) return '/inbox';
  try {
    const u = new URL(raw, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/inbox';
  } catch (e) {
    return '/inbox';
  }
}

self.addEventListener('push', (event) => {
  let p = {};
  try {
    p = event.data ? event.data.json() : {};
  } catch (e) {
    p = { body: event.data ? event.data.text() : '' };
  }
  const n = p.notification || {};
  const data = p.data || {};
  const url = tmSafePath((p.fcmOptions && p.fcmOptions.link) || data.url || p.url);
  const tag = n.tag || p.tag || data.ticketId;
  const opts = {
    body: n.body || p.body || '',
    icon: n.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: Object.assign({}, data, { url: url }),
  };
  if (tag) {
    // A newer update on the same ticket replaces the old one but still alerts.
    opts.tag = tag;
    opts.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(n.title || p.title || 'TaskManager', opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = tmSafePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Focus an open tab and ask it to route (lib/notifications/push ›
      // listenForNavigate); otherwise open a window straight at the deep link.
      const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) {
        return win.focus().then(() => win.postMessage({ type: 'tm:navigate', url: url }));
      }
      return self.clients.openWindow(url);
    }),
  );
});
