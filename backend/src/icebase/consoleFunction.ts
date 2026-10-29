/**
 * The IceBase console for a Firebase deploy of TaskManager, as its own Cloud Function
 * (`icebaseConsole`, deployed as a separate functions codebase, so the app's functions are never
 * touched). It acts on the project with the function's own service identity; the console's API
 * answers only the bearer of ICEBASE_CONSOLE_TOKEN (a Secret Manager secret).
 *
 * Deploy-time env (the deploy directory's .env, never this repo):
 *   ICEBASE_CONSOLE_STORAGE_BUCKET   the default bucket
 *   ICEBASE_CONSOLE_DATABASE_URL     the Realtime Database URL
 *   ICEBASE_CONSOLE_SITE             the app's origin (its /api and /v1 OpenAPI documents)
 */
import { timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { defineConfig } from '@panth977/icebase/config';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { serveFetch } from '@panth977/icebase-server/internal';
import { consoleHandler, firebaseConsoleExtras } from '@panth977/icebase-cli/console';
import { schema } from './schema.js';

const token = defineSecret('ICEBASE_CONSOLE_TOKEN');

const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? '';
const config = defineConfig({
  name: 'taskmanager',
  schema,
  firebase: {
    projectId,
    ...(process.env.ICEBASE_CONSOLE_STORAGE_BUCKET ? { storageBucket: process.env.ICEBASE_CONSOLE_STORAGE_BUCKET } : {}),
    ...(process.env.ICEBASE_CONSOLE_DATABASE_URL ? { databaseURL: process.env.ICEBASE_CONSOLE_DATABASE_URL } : {}),
  },
  console: {
    openapi: [
      { title: 'App API (POST /api/{command})', path: '/api/openapi.json' },
      { title: 'REST API (/v1)', path: '/v1/openapi.json' },
    ],
  },
  environments: { firebase: { mode: 'firebase' } },
});

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

let route: ((req: Request) => Promise<Response | null>) | null = null;
export const icebaseConsole = onRequest({ region: process.env.TM_REGION || 'us-central1', secrets: [token], memory: '512MiB', timeoutSeconds: 120, maxInstances: 2, concurrency: 20 }, async (req, res) => {
  route ??= consoleHandler(
    '',
    () => {
      const app = initializeAdminApp(config, 'firebase', { name: 'icebase-console' });
      return { config, env: 'firebase', app, firebase: firebaseConsoleExtras(app, config), ...(process.env.ICEBASE_CONSOLE_SITE ? { siteOrigin: process.env.ICEBASE_CONSOLE_SITE } : {}) };
    },
    async (r) => same(r.headers.get('authorization') ?? '', `Bearer ${token.value()}`),
  );
  await serveFetch(req, res, async (r) => (await route!(r)) ?? new Response('Not found', { status: 404 }));
});
