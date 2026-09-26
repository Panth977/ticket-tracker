/**
 * The merged worker's push half (agents.html § S, t4).
 *
 * static/firebase-messaging-sw.js is the ONE copy of the push and
 * notificationclick handlers, and src/service-worker.ts pulls it in with
 * importScripts. This test runs that exact file the way importScripts would —
 * as a classic script against a worker-shaped global — and proves a push still
 * arrives and its click still deep-links.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../../static/firebase-messaging-sw.js', import.meta.url)),
  'utf8',
);

interface Shown {
  title: string;
  options: Record<string, unknown>;
}
interface FakeClient {
  url: string;
  focused: boolean;
  posted: unknown[];
}

/** A minimal ServiceWorkerGlobalScope, and the handlers the file registers on it. */
function loadWorker(clients: FakeClient[] = []) {
  const listeners = new Map<string, (e: unknown) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://tasks.example' },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () =>
        Promise.resolve(
          clients.map((c) => ({
            url: c.url,
            focus: () => {
              c.focused = true;
              return Promise.resolve();
            },
            postMessage: (m: unknown) => c.posted.push(m),
          })),
        ),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
  };
  runInNewContext(SOURCE, { self, URL, Promise, console });
  return { listeners, shown, opened };
}

/** Run one handler and await whatever it passed to event.waitUntil. */
async function fire(
  listeners: Map<string, (e: unknown) => void>,
  type: string,
  event: Record<string, unknown>,
) {
  let waited: Promise<unknown> = Promise.resolve();
  listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => (waited = p) });
  await waited;
}

const push = (payload: unknown) => ({
  data: { json: () => payload, text: () => JSON.stringify(payload) },
});

describe('the merged worker: push', () => {
  it('shows an FCM payload and keeps its deep link', async () => {
    const { listeners, shown } = loadWorker();
    await fire(listeners, 'push', {
      ...push({
        notification: { title: 'Assigned to you', body: 'TM-12 Fix the loader' },
        data: { ticketId: 'tk_1', url: '/t/TM-12' },
        fcmOptions: { link: 'https://tasks.example/t/TM-12' },
      }),
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Assigned to you');
    expect(shown[0]!.options.body).toBe('TM-12 Fix the loader');
    expect(shown[0]!.options.data).toMatchObject({ url: '/t/TM-12', ticketId: 'tk_1' });
    // One notification per ticket, but a newer one still alerts.
    expect(shown[0]!.options.tag).toBe('tk_1');
    expect(shown[0]!.options.renotify).toBe(true);
  });

  it('shows the dev fake sender’s flat payload too', async () => {
    const { listeners, shown } = loadWorker();
    await fire(listeners, 'push', push({ title: 'Ping', body: 'hello', url: '/inbox' }));
    expect(shown[0]).toMatchObject({ title: 'Ping', options: { body: 'hello' } });
  });

  it('falls back to a title when the payload is not JSON', async () => {
    const { listeners, shown } = loadWorker();
    await fire(listeners, 'push', {
      data: {
        json: () => {
          throw new Error('not json');
        },
        text: () => 'plain',
      },
    });
    expect(shown[0]).toMatchObject({ title: 'TaskManager', options: { body: 'plain' } });
  });

  it('never routes a click off-origin', async () => {
    const { listeners, shown } = loadWorker();
    await fire(
      listeners,
      'push',
      push({ title: 'Evil', data: { url: 'https://evil.example/steal' } }),
    );
    expect(shown[0]!.options.data).toMatchObject({ url: '/inbox' });
  });
});

describe('the merged worker: notificationclick', () => {
  it('focuses an open tab and asks it to route', async () => {
    const tab: FakeClient = { url: 'https://tasks.example/inbox', focused: false, posted: [] };
    const { listeners, opened } = loadWorker([tab]);
    await fire(listeners, 'notificationclick', {
      notification: { data: { url: '/t/TM-12' }, close: () => {} },
    });
    expect(tab.focused).toBe(true);
    expect(tab.posted).toEqual([{ type: 'tm:navigate', url: '/t/TM-12' }]);
    expect(opened).toEqual([]);
  });

  it('opens a window at the deep link when nothing is open', async () => {
    const { listeners, opened } = loadWorker([]);
    await fire(listeners, 'notificationclick', {
      notification: { data: { url: '/t/TM-12' }, close: () => {} },
    });
    expect(opened).toEqual(['/t/TM-12']);
  });

  it('defaults to the inbox when the notification carries no url', async () => {
    const { listeners, opened } = loadWorker([]);
    await fire(listeners, 'notificationclick', { notification: { data: null, close: () => {} } });
    expect(opened).toEqual(['/inbox']);
  });
});
