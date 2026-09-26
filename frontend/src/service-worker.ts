/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * TaskManager's ONE service worker (SvelteKit registers it at scope '/').
 * docs/plan/agents.html § S.
 *
 *   PUSH    not here: static/firebase-messaging-sw.js is the single copy of the
 *           push / notificationclick handlers, and this worker imports it (see
 *           "one worker" below). Merging them is the point — two workers at one
 *           scope fight over the registration.
 *   SHELL   the built assets, the icons, the fonts and the SPA's HTML are
 *           precached into a cache named for this build's version, and served
 *           cache-first. `activate` deletes every older version's cache, so a
 *           deploy never leaves stale JS behind.
 *   OFFLINE a navigation falls back to the cached shell; /offline.html appears
 *           only when there is no cached shell at all (a first visit that went
 *           offline mid-flight). DATA is not cached here — Firestore's own
 *           IndexedDB cache keeps the last board readable and writes queue in
 *           the outbox (§ K).
 *   UPDATE  a new version waits instead of swapping under you; lib/pwa/update
 *           shows the toast and posts 'tm:skip-waiting' when you accept.
 */
import { base, build, files, version } from '$service-worker';
import { staticPages } from '$lib/pwa/pages';

const sw = self as unknown as ServiceWorkerGlobalScope;

/** One cache per build. Everything older is deleted on activate. */
const CACHE = `tm-${version}`;
/** The SPA's HTML, cached under this key (adapter-static serves one index.html for every route). */
const SHELL = `${base}/`;
const OFFLINE = `${base}/offline.html`;

/**
 * SvelteKit's dynamic public env, fetched by the client at boot and NOT part of
 * `build` (it has no content hash, it is written per deploy). Miss it and the
 * app cannot start offline at all — it is the first module the boot awaits.
 * `_app` is kit.appDir; a service worker may not import svelte.config.js.
 */
const ENV = `${base}/_app/env.js`;

/** The app shell: hashed build output + the static files svelte.config.js lets through. */
const PRECACHE = [...build, ...files, ENV];
const PRECACHED = new Set(PRECACHE);

/**
 * Static HTML pages that are NOT the SPA: /integrate (the page an orchestrator
 * is pointed at), /qa/mobile.html, /offline.html. Without this every navigation
 * below falls through to "render the shell", and an installed worker turns
 * /integrate into the SPA's own Not found — a page that works in a fresh
 * browser and 404s once the app is installed. lib/pwa/pages.ts does the mapping
 * (and is unit-tested there; a service worker cannot be imported by a test).
 */
const PAGES = staticPages(files, base);

/** Never intercepted: the backend doors (firebase.json rewrites) and emulator traffic. */
const PASSTHROUGH = [
  '/api',
  '/v1',
  '/mcp',
  '/oauth/',
  '/hooks',
  '/ics',
  '/integrations',
  '/.well-known',
  '/__',
];

// ── one worker ───────────────────────────────────────────────────────────────
const MESSAGING = `${base}/firebase-messaging-sw.js`;
/**
 * Are we the built worker or `vite dev`'s? `$service-worker`'s `build` is empty
 * in dev by construction and never empty in a real build — and a service worker
 * may not import $app/environment, so this is the honest signal. (`typeof
 * importScripts` is NOT: it exists in a module worker too and merely throws
 * when called, which would kill the script before it registered.)
 *
 * It decides two things. The built worker is a CLASSIC script, so importScripts
 * can drop the messaging worker's push / notificationclick handlers straight
 * into it — one registration, one scope, one copy of the code (§ S). `vite dev`
 * registers this as a MODULE worker, which cannot importScripts; dev loses
 * nothing, because lib/notifications/push mints `dev-web:*` tokens the backend's
 * fake sender never turns into a real web push. And a navigation may only be
 * answered from the cache when built: in dev the shell has to come from the dev
 * server, or an edit to app.html would never reach the browser again.
 */
const BUILT = build.length > 0;
if (BUILT) importScripts(MESSAGING);

// ── install: precache the shell ──────────────────────────────────────────────

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One request each, not addAll: a single 404 (a file listed but not built
      // in dev) must not throw away the whole precache.
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            const res = await fetch(path, { cache: 'reload' });
            if (res.ok) await cache.put(path, res);
          } catch {
            /* offline while installing — the fetch handler will fill it in */
          }
        }),
      );
      // The HTML itself is not in `build`; fetch it once so a cold reload works
      // offline, and keep the offline page beside it.
      for (const path of [SHELL, OFFLINE]) {
        try {
          const res = await fetch(path, { cache: 'reload' });
          if (res.ok) await cache.put(path, res);
        } catch {
          /* ignore */
        }
      }
      // We do NOT skipWaiting here: a waiting worker is what lets lib/pwa/update
      // offer the toast instead of swapping the running app out underneath you.
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        // 'tm-shell' is the pre-§S cache name; drop it too.
        if ((key.startsWith('tm-') || key === 'tm-shell') && key !== CACHE)
          await caches.delete(key);
      }
      await sw.clients.claim();
    })(),
  );
});

/** lib/pwa/update.svelte.ts asks a waiting worker to take over. */
sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'tm:skip-waiting') void sw.skipWaiting();
});

// ── fetch: cache-first shell, network-only data ──────────────────────────────

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  if (PASSTHROUGH.some((p) => url.pathname.startsWith(p))) return;

  // A static page of its own (not an SPA route): answer with that page's file.
  const page = PAGES.get(url.pathname);

  // Precached, content-hashed or versioned by the build: the cache is the truth.
  if (PRECACHED.has(url.pathname) || page) {
    // The mapped FILE is the cache key and what we fetch: /integrate would
    // otherwise be a hosting redirect, and a navigation may not be answered
    // with a redirected response.
    const key = page ?? url.pathname;
    event.respondWith(
      (async () => {
        const hit = await caches.match(key, { cacheName: CACHE });
        if (hit) return hit;
        const res = await fetch(page ? key : req);
        if (res.ok) void (await caches.open(CACHE)).put(key, res.clone());
        return res;
      })(),
    );
    return;
  }

  // Every route renders from the one shell (adapter-static fallback).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = BUILT ? await cache.match(SHELL) : null;
        if (cached) {
          // Serve instantly, then refresh in the background. A genuinely new
          // build arrives as a new service worker (and the update toast), not
          // as different HTML under the running app.
          void fetch(SHELL)
            .then((res) => (res.ok ? cache.put(SHELL, res) : undefined))
            .catch(() => {});
          return cached;
        }
        try {
          const res = await fetch(req);
          if (res.ok) void cache.put(SHELL, res.clone());
          return res;
        } catch {
          // Offline: the shell if we have it, the offline page if we never did.
          return (await cache.match(SHELL)) ?? (await cache.match(OFFLINE)) ?? Response.error();
        }
      })(),
    );
  }
});
