#!/usr/bin/env node
/**
 * ORCH-9 (dictionary.html §F) on a FIREBASE project: every `_env/{kind}:{id}`
 * becomes a dictionary granted where its pairs applied. The logic is the
 * backend's own (backend/src/migrate/dictionary.ts — the VM runs the same
 * through backend/lib/migrate/dictionaryCli.js).
 *
 * DRY RUN BY DEFAULT; --apply writes. IDEMPOTENT.
 *
 *   pnpm --filter @tm/backend build
 *   TM_GCLOUD_ACCOUNT=you@… node scripts/migrate-dictionary.mjs --project <id>
 *   TM_GCLOUD_ACCOUNT=you@… node scripts/migrate-dictionary.mjs --project <id> --apply
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
let project = '';
let apply = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-P') project = argv[++i] ?? '';
  else if (a === '--apply') apply = true;
  else {
    console.error(`migrate-dictionary: unknown argument ${a}`);
    process.exit(2);
  }
}
if (!project) {
  console.error('migrate-dictionary: --project <id> is required');
  process.exit(2);
}
process.env.GCLOUD_PROJECT = project;
process.env.GOOGLE_CLOUD_PROJECT = project;
process.env.METADATA_SERVER_DETECTION ||= 'none';

const requireFromBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const fromBackend = (spec) => pathToFileURL(requireFromBackend.resolve(spec)).href;
const { initializeApp, getApps } = await import(fromBackend('firebase-admin/app'));
const { getFirestore } = await import(fromBackend('firebase-admin/firestore'));
const { gcloudCredential, gcloudClients } = await import('./lib/gcloud-credential.mjs');
const { migrateEnvToDictionaries } = await import(
  new URL('../backend/lib/migrate/dictionary.js', import.meta.url).href
);

const credential = gcloudCredential();
const app =
  getApps()[0] ?? initializeApp({ projectId: project, ...(credential ? { credential } : {}) });
const g = gcloudClients(project, {
  createRequire,
  adminEntry: requireFromBackend.resolve('firebase-admin/firestore'),
});
const db = g ? g.db : getFirestore(app);
const s = await migrateEnvToDictionaries({
  db,
  apply,
  log: (m) => console.log(`\x1b[34mdictionary\x1b[0m │ ${m}`),
});
console.log(apply ? 'applied' : 'DRY RUN — nothing written (add --apply)', JSON.stringify(s));
process.exit(0);
