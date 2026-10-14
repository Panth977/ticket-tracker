/**
 * THE REALTIME DATABASE'S REST API, ON A VM — the part agents and the SDK use
 * (sdk/src/watch.ts, the workspaces orch): GET /v1/live hands them a
 * `database_url` and an `auth`, and they read or stream
 *
 *   GET /rtdb/{path}.json?auth=<id token>                         → the value (JSON)
 *   GET /rtdb/{path}.json?auth=…  (Accept: text/event-stream)     → Server-Sent Events:
 *       event: put         data: {"path":"/","data":<value>}     now, then on every change
 *       event: keep-alive  data: null                           every 30 s
 *       event: auth_revoked                                      when the credential expires
 *
 * — the same protocol as Firebase's REST streaming, from the VM's JSON tree,
 * checked by database.rules.json. On Firebase (TM_RTDB=firebase) the route
 * does not exist: the real RTDB serves it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errors } from '@tm/shared';
import { door } from '../http/mounts.js';
import { identity } from '../identity/index.js';
import { rtdbKind } from '../rtdb/index.js';
import { localTree, splitPath } from '../rtdb/local.js';
import { DatabaseRules, type RtdbAuth } from '../rules/database.js';

const rest = door('rtdb');

let rules: DatabaseRules | undefined;
const databaseRules = () =>
  (rules ??= new DatabaseRules(
    readFileSync(process.env.TM_RULES_DATABASE || fileURLToPath(new URL('../../database.rules.json', import.meta.url)), 'utf8'),
  ));

const overlaps = (a: string[], b: string[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return false;
  return true;
};

rest.get('/*', async (c) => {
  if (rtdbKind() !== 'local') throw errors.not_found('No route');
  const raw = c.req.path.slice(c.req.path.indexOf('/rtdb') + '/rtdb'.length);
  if (!raw.endsWith('.json')) throw errors.not_found('Paths end in .json');
  let segs: string[];
  try {
    segs = splitPath(decodeURIComponent(raw.slice(0, -'.json'.length)));
  } catch {
    throw errors.invalid('Bad path');
  }
  let auth: RtdbAuth | null = null;
  let expiresAt = Infinity;
  const token = c.req.query('auth');
  if (token) {
    try {
      const d = await identity().verifyIdToken(token, true);
      auth = { uid: d.uid, token: d as unknown as Record<string, unknown> };
      expiresAt = d.exp * 1000;
    } catch {
      return c.json({ error: 'Auth token is expired' }, 401);
    }
  }
  const r = databaseRules();
  const tree = localTree();
  if (!r.canRead(auth, tree.root as never, segs)) return c.json({ error: 'Permission denied' }, 401);
  if (!(c.req.header('accept') ?? '').includes('text/event-stream')) return c.json(tree.read(segs));

  const enc = new TextEncoder();
  let off: (() => void) | undefined;
  let ping: NodeJS.Timeout | undefined;
  let expiry: NodeJS.Timeout | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      let last = '';
      const frame = (event: string, data: unknown) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const end = () => {
        off?.();
        clearInterval(ping);
        clearTimeout(expiry);
        try {
          ctrl.close();
        } catch {
          /* already closed */
        }
      };
      const put = () => {
        if (!r.canRead(auth, tree.root as never, segs)) {
          frame('cancel', 'Permission denied');
          return end();
        }
        const json = JSON.stringify(tree.read(segs));
        if (json === last) return;
        last = json;
        ctrl.enqueue(enc.encode(`event: put\ndata: {"path":"/","data":${json}}\n\n`));
      };
      put();
      off = tree.onWrite((paths) => {
        if (paths.some((p) => overlaps(p.split('/').filter(Boolean), segs))) put();
      });
      ping = setInterval(() => frame('keep-alive', null), 30_000);
      if (Number.isFinite(expiresAt))
        expiry = setTimeout(() => {
          frame('auth_revoked', 'credential is no longer valid');
          end();
        }, Math.max(0, expiresAt - Date.now()));
    },
    cancel() {
      off?.();
      clearInterval(ping);
      clearTimeout(expiry);
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
});
