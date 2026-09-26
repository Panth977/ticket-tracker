/**
 * Browser push (app/db.json › devices; backend notify/deliver.ts › push).
 *
 *   WHEN WE ASK   at the first assignment — the moment a notification is
 *                 obviously useful — never on page load (browsers penalise
 *                 cold prompts, and people say no to them). "Not now" is
 *                 remembered for 14 days.
 *   WHAT WE STORE users/{uid}/devices/{deviceId} = { fcmToken, kind:'web',
 *                 userAgent, lastSeenAt }. deviceId is stable per browser
 *                 (localStorage), so re-registering overwrites, never piles
 *                 up. The client writes this directly (rules: validDevice()).
 *   THE TOKEN     real FCM token when PUBLIC_FCM_VAPID_KEY is set and we are
 *                 not on the emulators; otherwise a dev token `dev-web:<id>`
 *                 that the backend's fake push sender accepts, so the whole
 *                 flow (deliveries, Recent deliveries panel) works offline.
 *   CLICK         the service worker focuses a tab and posts
 *                 { type: 'tm:navigate', url }; listenForNavigate() routes it.
 */
import { deleteDoc, doc, setDoc } from 'firebase/firestore';
import { env } from '$env/dynamic/public';
import { paths, type Device } from '@tm/shared';
import { getDb, getFirebaseApp, USE_EMULATORS } from '$lib/firebase/client';

const DEVICE_KEY = 'tm.push.deviceId';
const DISMISS_KEY = 'tm.push.notNowAt';
const SEEN_KEY = 'tm.push.lastSeenAt';
const NOT_NOW_MS = 14 * 24 * 60 * 60 * 1000;
const REFRESH_MS = 24 * 60 * 60 * 1000;
/** The FCM SDK's default scope for its own worker — used only when the app worker is absent. */
const FCM_SCOPE = '/firebase-cloud-messaging-push-scope';

export type PushPermission = NotificationPermission | 'unsupported';

function ls(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/** A random id for this browser, kept in localStorage. */
export function deviceId(): string {
  const s = ls();
  let id = s?.getItem(DEVICE_KEY) ?? null;
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    id = 'web_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    s?.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** True when real FCM tokens can be minted (a VAPID key and a real project). */
export function realFcm(): boolean {
  return !!env.PUBLIC_FCM_VAPID_KEY && !USE_EMULATORS;
}

async function workerRegistration(): Promise<ServiceWorkerRegistration> {
  // Prefer the app's own worker (src/service-worker.ts, scope '/') — one worker per scope.
  const app = await navigator.serviceWorker.getRegistration('/');
  if (app) return app;
  return navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: FCM_SCOPE });
}

async function pushToken(): Promise<string> {
  if (!realFcm()) return `dev-web:${deviceId()}`;
  const { getMessaging, getToken, isSupported } = await import('firebase/messaging');
  if (!(await isSupported())) throw new Error('This browser does not support push messages');
  return getToken(getMessaging(getFirebaseApp()), {
    vapidKey: env.PUBLIC_FCM_VAPID_KEY,
    serviceWorkerRegistration: await workerRegistration(),
  });
}

/** Write (or refresh) this browser's device document. */
export async function registerDevice(uid: string, now = Date.now()): Promise<void> {
  const fcmToken = await pushToken();
  const device: Device = {
    fcmToken,
    kind: 'web',
    userAgent: navigator.userAgent.slice(0, 1024),
    lastSeenAt: now,
  };
  await setDoc(doc(getDb(), paths.device(uid, deviceId())), device);
  ls()?.setItem(SEEN_KEY, String(now));
}

/** Stop pushing to this browser. */
export async function unregisterDevice(uid: string): Promise<void> {
  await deleteDoc(doc(getDb(), paths.device(uid, deviceId())));
  ls()?.removeItem(SEEN_KEY);
}

class PushController {
  permission = $state<PushPermission>('unsupported');
  /** The ask card is showing. */
  asking = $state(false);
  busy = $state(false);
  error = $state<string | null>(null);

  constructor() {
    this.sync();
  }

  sync() {
    this.permission = pushSupported() ? Notification.permission : 'unsupported';
  }

  /** "Not now" within the last 14 days. */
  snoozed(now = Date.now()): boolean {
    const at = Number(ls()?.getItem(DISMISS_KEY) ?? 0);
    return at > 0 && now - at < NOT_NOW_MS;
  }

  /** Should the first-assignment prompt show? */
  shouldAsk(now = Date.now()): boolean {
    this.sync();
    return this.permission === 'default' && !this.snoozed(now);
  }

  ask() {
    if (this.shouldAsk()) this.asking = true;
  }

  notNow() {
    this.asking = false;
    ls()?.setItem(DISMISS_KEY, String(Date.now()));
  }

  /** Must run from a click: some browsers only prompt inside a user gesture. */
  async enable(uid: string): Promise<boolean> {
    if (!pushSupported()) return false;
    this.busy = true;
    this.error = null;
    try {
      const p = await Notification.requestPermission();
      this.permission = p;
      if (p !== 'granted') {
        this.asking = false;
        if (p === 'default') this.notNow();
        return false;
      }
      await registerDevice(uid);
      this.asking = false;
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  async disable(uid: string): Promise<void> {
    await unregisterDevice(uid);
  }

  /**
   * On app load: permission already granted → refresh lastSeenAt (and the
   * token, which FCM may have rotated) at most once a day.
   */
  async refresh(uid: string, now = Date.now()): Promise<void> {
    this.sync();
    if (this.permission !== 'granted') return;
    const last = Number(ls()?.getItem(SEEN_KEY) ?? 0);
    if (now - last < REFRESH_MS) return;
    try {
      await registerDevice(uid, now);
    } catch {
      /* try again next load */
    }
  }
}

export const push = new PushController();

/** Route notification clicks the service worker hands to an open tab. */
export function listenForNavigate(go: (url: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const on = (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type === 'tm:navigate' && typeof d.url === 'string' && d.url.startsWith('/')) go(d.url);
  };
  navigator.serviceWorker.addEventListener('message', on);
  return () => navigator.serviceWorker.removeEventListener('message', on);
}
