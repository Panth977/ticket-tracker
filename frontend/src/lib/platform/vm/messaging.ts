/**
 * `firebase/messaging` FOR THE VM BUILD — a plain Web Push subscription with
 * the server's VAPID key (/config.json), handed to the backend as the device
 * token `webpush:<base64url(subscription JSON)>`; the server pushes to it
 * directly (backend adapters/webPush.ts). The service worker that shows the
 * notification is the same one (static/firebase-messaging-sw.js).
 */
export const getMessaging = (..._a: unknown[]) => ({ type: 'messaging' });

export async function isSupported(): Promise<boolean> {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

let vapid: Promise<string> | null = null;
function vapidKey(): Promise<string> {
  vapid ??= fetch('/config.json')
    .then((r) => r.json() as Promise<{ vapidKey?: string }>)
    .then((c) => {
      if (!c.vapidKey) throw new Error('This server has no push key');
      return c.vapidKey;
    });
  return vapid;
}

const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const toB64u = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function getToken(_m: unknown, opts: { serviceWorkerRegistration?: ServiceWorkerRegistration } = {}): Promise<string> {
  const reg = opts.serviceWorkerRegistration ?? (await navigator.serviceWorker.ready);
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked');
  const key = await vapidKey();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (a different server) cannot be reused.
  const same = sub?.options.applicationServerKey && toB64uBytes(new Uint8Array(sub.options.applicationServerKey)) === key;
  if (sub && !same) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
  return `webpush:${toB64u(JSON.stringify(sub.toJSON()))}`;
}

function toB64uBytes(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function deleteToken(): Promise<boolean> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  return sub ? sub.unsubscribe() : true;
}

export const onMessage = (..._a: unknown[]) => () => {};
