/**
 * TaskManager on the IceBase server (TM_PLATFORM=icebase): `icebase serve` in this directory runs
 * the web app (frontend/build, routed as firebase.json routes it), the functions
 * (backend/lib/index.js — the same exports Cloud Functions runs), and the database, auth,
 * storage, realtime database and task queues they use, on one port.
 *
 * Build first (pnpm build:icebase): the schema and the functions are read from backend/lib.
 */
import { readFileSync } from 'node:fs';
import { defineConfig } from '@panth977/icebase/config';
import { schema } from './backend/lib/icebase/schema.js';

type Rewrite = { source: string; function?: string | { functionId: string; region?: string }; destination?: string };
type Header = { source: string; headers: { key: string; value: string }[] };
const firebase = JSON.parse(readFileSync(new URL('./firebase.json', import.meta.url), 'utf8')) as {
  hosting: { target?: string; public: string; rewrites?: Rewrite[]; headers?: Header[] }[];
};
const app = firebase.hosting.find((h) => h.target === 'app') ?? firebase.hosting[0]!;

const projectId = process.env.GCLOUD_PROJECT || 'taskmanager';

export default defineConfig({
  name: 'taskmanager',
  schema,
  rules: { firestore: 'backend/firestore.rules', storage: 'backend/storage.rules', database: 'backend/database.rules.json' },
  functions: { source: 'backend', region: process.env.TM_REGION || 'us-central1' },
  hosting: {
    public: app.public,
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
  emulator: { dataDir: process.env.TM_DATA_DIR ? `${process.env.TM_DATA_DIR}/icebase` : 'data/icebase' },
  environments: { server: { mode: 'emulator' } },
});
