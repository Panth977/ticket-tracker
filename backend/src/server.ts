/**
 * THE VM ENTRY POINT (TM_PLATFORM=vm) — one process, ONE PORT, everything on
 * paths:
 *
 *   /api /v1 /mcp /oauth /hooks /ics /integrations /.well-known /c/…   the api (as the Firebase function)
 *   /identity/…   sign-in (local identity)        /blob/…   signed object URLs
 *   /live         WebSocket: the live data engine (live/data.ts)
 *   /config.json  what the browser needs to know about this deploy
 *   everything else: the web app (frontend/build), exactly as Firebase Hosting
 *   serves it — static files first, then firebase.json's rewrites in order,
 *   with firebase.json's headers. firebase.json stays the one description of
 *   routing for both deploys.
 *
 * Also runs the in-process task queue + scheduler (runtime/localJobs.ts) and
 * the local triggers. `node lib/server.js` (PORT, default 8080).
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApp } from './http/app.js';
import { identity } from './identity/index.js';
import { DataSession } from './live/data.js';
import { ensureVapid } from './adapters/webPush.js';
import { ensureServerSecrets } from './runtime/deploy.js';
import { startLocalJobs } from './runtime/localJobs.js';
import { platform } from './runtime/platform.js';

const here = fileURLToPath(new URL('.', import.meta.url));
/** The repository root (backend/src or backend/lib → two up). */
const ROOT = resolve(here, '..', '..');
const WEB_DIR = resolve(process.env.TM_WEB_DIR || join(ROOT, 'frontend', 'build'));
const HOSTING = resolve(process.env.TM_HOSTING_CONFIG || join(ROOT, 'firebase.json'));

// ─── hosting (firebase.json) ─────────────────────────────────────────────────

interface Rewrite {
  test: (p: string) => boolean;
  destination?: string;
  api?: boolean;
}
interface HeaderRule {
  test: (p: string) => boolean;
  headers: [string, string][];
}

/** Firebase Hosting globs: ** any depth, * one segment, a leading ! negates. */
export function glob(pattern: string): (p: string) => boolean {
  const neg = pattern.startsWith('!');
  const src = neg ? pattern.slice(1) : pattern;
  let re = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '*' && src[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp(`^${re}$`);
  return (p) => rx.test(p) !== neg;
}

function loadHosting(): { rewrites: Rewrite[]; headers: HeaderRule[] } {
  const cfg = JSON.parse(readFileSync(HOSTING, 'utf8')) as {
    hosting: {
      target?: string;
      rewrites?: { source: string; destination?: string; function?: unknown }[];
      headers?: { source: string; headers: { key: string; value: string }[] }[];
    }[];
  };
  const app = cfg.hosting.find((h) => h.target === 'app') ?? cfg.hosting[0]!;
  return {
    rewrites: (app.rewrites ?? []).map((r) => ({
      test: glob(r.source),
      destination: r.destination,
      api: !!r.function,
    })),
    headers: (app.headers ?? []).map((h) => ({
      test: glob(h.source),
      headers: h.headers.map((x) => [x.key, x.value] as [string, string]),
    })),
  };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.tgz': 'application/gzip',
  '.ts': 'application/typescript; charset=utf-8',
};

/** The file a path names in the web dir (a directory → its index.html), or null. */
function staticFile(urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = normalize(join(WEB_DIR, rel));
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + sep)) return null;
  try {
    const st = statSync(full);
    if (st.isFile()) return full;
    if (st.isDirectory() && existsSync(join(full, 'index.html'))) return join(full, 'index.html');
  } catch {
    /* not there */
  }
  return null;
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  urlPath: string,
  headers: HeaderRule[],
): void {
  res.statusCode = 200;
  res.setHeader('content-type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
  // Hosting's defaults: HTML revalidates, hashed build assets are forever.
  res.setHeader(
    'cache-control',
    file.endsWith('.html')
      ? 'no-cache'
      : urlPath.startsWith('/_app/immutable/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
  );
  for (const h of headers) if (h.test(urlPath)) for (const [k, v] of h.headers) res.setHeader(k, v);
  // Compressed as Hosting serves it: brotli or gzip for text, made once per
  // file (the build never changes under a running server) and kept in memory.
  const enc = compressible(file) ? pickEncoding(req.headers['accept-encoding']) : null;
  res.setHeader('vary', 'accept-encoding');
  if (enc) {
    const body = compressed(file, enc);
    res.setHeader('content-encoding', enc);
    res.setHeader('content-length', body.length);
    return void res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.setHeader('content-length', statSync(file).size);
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.xml', '.webmanifest', '.map', '.md', '.ts']);
const compressible = (file: string) =>
  COMPRESSIBLE.has(extname(file).toLowerCase()) && statSync(file).size > 1024;

function pickEncoding(header: string | string[] | undefined): 'br' | 'gzip' | null {
  const h = String(header ?? '');
  if (/\bbr\b/.test(h)) return 'br';
  if (/\bgzip\b/.test(h)) return 'gzip';
  return null;
}

const zipped = new Map<string, Buffer>();
function compressed(file: string, enc: 'br' | 'gzip'): Buffer {
  const key = `${enc}:${file}`;
  let b = zipped.get(key);
  if (!b) {
    const raw = readFileSync(file);
    b =
      enc === 'br'
        ? brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9 } })
        : gzipSync(raw, { level: 9 });
    zipped.set(key, b);
  }
  return b;
}

/** Routes the VM adds to what Firebase Hosting rewrites to the api. */
const VM_API = [glob('/identity/**'), glob('/blob/**'), glob('/c/**'), glob('/rtdb/**')];

export async function startServer(
  port = Number(process.env.PORT || 8080),
): Promise<{ close(): Promise<void>; port: number }> {
  if (platform() !== 'vm')
    console.warn(
      '[server] TM_PLATFORM is not "vm": this entry is meant for the VM / Docker deploy',
    );
  await ensureServerSecrets();
  const app = await createApp();
  const api = getRequestListener(app.fetch);
  const { rewrites, headers } = loadHosting();
  const { publicKey: vapidKey } = await ensureVapid();
  const config = JSON.stringify({
    platform: 'vm',
    vapidKey,
    adminEmail: process.env.TM_ADMIN_EMAIL ?? null,
    artifactOrigin: process.env.TM_ARTIFACT_ORIGIN ?? null,
  });

  // The SPA's $env/dynamic/public, decided HERE rather than at build time: one
  // image serves any deploy. TM_ADMIN_EMAIL is the admin the app shows; any
  // PUBLIC_* variable of the server is passed through.
  const publicEnv: Record<string, string> = {
    PUBLIC_USE_EMULATORS: 'false',
    PUBLIC_FIREBASE_PROJECT_ID: 'vm',
    PUBLIC_FCM_VAPID_KEY: 'from-server',
    ...(process.env.TM_ADMIN_EMAIL ? { PUBLIC_TM_ADMIN_EMAIL: process.env.TM_ADMIN_EMAIL } : {}),
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[0].startsWith('PUBLIC_') && typeof e[1] === 'string',
      ),
    ),
  };
  const envJs = `export const env=${JSON.stringify(publicEnv)}`;

  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0]!;
    if (urlPath === '/_app/env.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      });
      return void res.end(envJs);
    }
    if (urlPath === '/config.json') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      });
      return void res.end(config);
    }
    if (VM_API.some((t) => t(urlPath))) return void api(req, res);
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    // Hosting: an existing file wins over every rewrite.
    const file = isRead ? staticFile(urlPath) : null;
    if (file) return sendFile(req, res, file, urlPath, headers);
    for (const r of rewrites) {
      if (!r.test(urlPath)) continue;
      if (r.api) return void api(req, res);
      const dest = r.destination ? staticFile(r.destination) : null;
      if (dest && isRead) return sendFile(req, res, dest, urlPath, headers);
      break;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
  });

  // /live — the WebSocket of the live data engine. The first frame is
  // { op: 'auth', token } (an ID token; omitted = signed out).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/live') return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
  });

  const stopJobs = startLocalJobs();
  await new Promise<void>((ok) => server.listen(port, ok));
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  console.info(`[server] listening on :${actual} (web ${WEB_DIR})`);
  return {
    port: actual,
    close: async () => {
      stopJobs();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

function onSocket(ws: WebSocket): void {
  let session: DataSession | undefined;
  // A ping every 25 s keeps proxies (nginx, load balancers) from closing an
  // idle socket, and ends one whose browser vanished without a close.
  let alive = true;
  ws.on('pong', () => (alive = true));
  const beat = setInterval(() => {
    if (!alive) return void ws.terminate();
    alive = false;
    ws.ping();
  }, 25_000);
  const send = (m: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  let chain = Promise.resolve();
  ws.on('message', (raw) => {
    let msg: { id?: string; op?: string; token?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return void ws.close(1003, 'JSON frames only');
    }
    chain = chain.then(async () => {
      if (msg.op === 'auth') {
        let auth: { uid: string; token: Record<string, unknown> } | null = null;
        if (msg.token) {
          try {
            const d = await identity().verifyIdToken(msg.token, true);
            auth = { uid: d.uid, token: d as unknown as Record<string, unknown> };
          } catch {
            send({
              id: msg.id,
              ok: false,
              error: { code: 'unauthenticated', message: 'Invalid or expired ID token' },
            });
            return;
          }
        }
        // A refreshed token for the same person keeps the session (its
        // listeners and onDisconnect writes); anyone else starts afresh.
        if (session && (session.auth?.uid ?? null) === (auth?.uid ?? null)) session.reauth(auth);
        else {
          session?.close();
          session = new DataSession(auth, send);
        }
        send({ id: msg.id, ok: true, result: { uid: auth?.uid ?? null } });
        return;
      }
      if (!session) session = new DataSession(null, send);
      await session.handle(msg as never);
    });
  });
  ws.on('close', () => {
    clearInterval(beat);
    session?.close();
  });
}

// `node lib/server.js` runs it; importing (tests) does not.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((e) => {
    console.error('[server] failed to start', e);
    process.exit(1);
  });
}
