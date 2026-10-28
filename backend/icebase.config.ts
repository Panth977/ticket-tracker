/**
 * TaskManager on the IceBase server (TM_ICEBASE=emulator): `icebase serve` in backend/ runs
 * the web app (frontend/build, routed as firebase.json routes it), the functions
 * (lib/index.js — the same exports Cloud Functions runs), and the database, auth,
 * storage, realtime database and task queues they use, on one port.
 *
 * Build first: the schema and the functions are read from lib/ (pnpm --filter @tm/backend build),
 * the web app from ../frontend/build (TM_ICEBASE=emulator pnpm --filter @tm/frontend build).
 */
import { readFileSync } from 'node:fs';
import { defineConfig } from '@panth977/icebase/config';
import { schema } from './lib/icebase/schema.js';

type Rewrite = { source: string; function?: string | { functionId: string; region?: string }; destination?: string };
type Header = { source: string; headers: { key: string; value: string }[] };
const firebase = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8')) as {
  hosting: { target?: string; public: string; rewrites?: Rewrite[]; headers?: Header[] }[];
};
const app = firebase.hosting.find((h) => h.target === 'app') ?? firebase.hosting[0]!;

const projectId = process.env.GCLOUD_PROJECT || 'taskmanager';

export default defineConfig({
  name: 'taskmanager',
  schema,
  rules: { firestore: 'firestore.rules', storage: 'storage.rules', database: 'database.rules.json' },
  functions: { source: '.', region: process.env.TM_REGION || 'us-central1' },
  hosting: {
    // scripts/icebase-start.mjs serves a branded copy (TM_WEB_DIR); else the build itself.
    public: process.env.TM_WEB_DIR || `../${app.public}`,
    rewrites: [
      // Artifact files: Firebase serves them on a second site; here, the same origin (as on a VM).
      { source: '/c/**', function: 'api' },
      // What the browser needs to know about this deploy (the VM server's, now the api's).
      { source: '/config.json', function: 'api' },
      ...(app.rewrites ?? []).map((r) => (r.function ? { source: r.source, function: r.function } : { source: r.source, destination: r.destination! })),
    ],
    headers: (app.headers ?? []).map((h) => ({ source: h.source, headers: Object.fromEntries(h.headers.map((x) => [x.key, x.value])) })),
  },
  auth: { providers: ['password', 'emailLink'] },
  firebase: { projectId, storageBucket: `${projectId}.appspot.com` },
  // The console (/__/icebase/console): its APIs page shows both API documents; the deployments it
  // switches between are named per deploy (TM_CONSOLE_TARGETS='[{"name":"…","url":"https://…/__/icebase/console"}]').
  console: {
    targets: JSON.parse(process.env.TM_CONSOLE_TARGETS || '[]') as { name: string; url: string }[],
    openapi: [
      { title: 'App API (POST /api/{command})', path: '/api/openapi.json' },
      { title: 'REST API (/v1)', path: '/v1/openapi.json' },
    ],
  },
  // The realtime socket also on /live: the path a proxy in front of a VM deploy already upgrades.
  emulator: { socketPath: '/live', dataDir: process.env.TM_DATA_DIR ? `${process.env.TM_DATA_DIR}/icebase` : '../data/icebase' },
  environments: { server: { mode: 'emulator' } },
});
