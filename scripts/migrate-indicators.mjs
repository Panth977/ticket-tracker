#!/usr/bin/env node
/**
 * indicators.html §Migration — EVERY ENTITY GETS AN INDICATOR; BOARD
 * DESCRIPTIONS BECOME PLAIN TEXT.
 *
 *   · every board (archived ones too): indicator from its legacy color + typed
 *     icon; rich-text description → plain text (Markdown); every stage gets an
 *     indicator from its colour (stage descriptions stay absent);
 *   · every artifact: its emoji icon, else a palette colour;
 *   · every memory: its emoji icon, else 🧠 (the old default);
 *   · every person's workspace (users/{uid}/workspaces): its colour.
 *
 * The logic is scripts/lib/indicators.mjs (unit + emulator tested). Nothing
 * legacy is deleted: color / icon stay beside the new indicator.
 *
 * DRY RUN BY DEFAULT: prints the plan, writes nothing. --apply writes.
 * IDEMPOTENT: a doc that already has its indicator plans nothing, so a re-run
 * writes nothing.
 *
 *   pnpm --filter @tm/shared build
 *   node scripts/migrate-indicators.mjs --project <id>            # dry run
 *   node scripts/migrate-indicators.mjs --project <id> --apply    # write
 *
 * Credentials: application-default, or TM_GCLOUD_ACCOUNT=<you@…> (the gcloud
 * CLI's account, lib/gcloud-credential.mjs), or the emulator when
 * FIRESTORE_EMULATOR_HOST is set. --project is REQUIRED: this script never
 * guesses which database it changes.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { migrateIndicators } from './lib/indicators.mjs';

const argv = process.argv.slice(2);
let project = '';
let apply = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-P') project = argv[++i] ?? '';
  else if (a.startsWith('--project=')) project = a.slice('--project='.length);
  else if (a === '--apply') apply = true;
  else if (a === '--dry-run' || a === '-n') apply = false;
  else {
    console.error(`migrate-indicators: unknown argument ${a}`);
    process.exit(2);
  }
}
if (!project) {
  console.error('migrate-indicators: --project <id> is required');
  process.exit(2);
}

process.env.GCLOUD_PROJECT = project;
process.env.GOOGLE_CLOUD_PROJECT = project;
process.env.METADATA_SERVER_DETECTION ||= 'none';

// firebase-admin and @tm/shared are dependencies of the FUNCTIONS package.
const requireFromBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const fromBackend = (spec) => pathToFileURL(requireFromBackend.resolve(spec)).href;
const { initializeApp, getApps } = await import(fromBackend('firebase-admin/app'));
const { getFirestore } = await import(fromBackend('firebase-admin/firestore'));
const S = await import(fromBackend('@tm/shared'));
const { gcloudCredential, gcloudClients } = await import('./lib/gcloud-credential.mjs');
if (typeof S.indicatorOf !== 'function' || typeof S.descriptionText !== 'function') {
  console.error('migrate-indicators: shared/dist is stale. Run: pnpm --filter @tm/shared build');
  process.exit(2);
}

const log = (m = '') => console.log(`\x1b[34mindicators\x1b[0m │ ${m}`);

async function main() {
  const credential = gcloudCredential();
  const app =
    getApps()[0] ?? initializeApp({ projectId: project, ...(credential ? { credential } : {}) });
  const g = gcloudClients(project, {
    createRequire,
    adminEntry: requireFromBackend.resolve('firebase-admin/firestore'),
  });
  const db = g ? g.db : getFirestore(app);
  const emu = process.env.FIRESTORE_EMULATOR_HOST;
  log(
    `project ${project}${emu ? ` (emulator: firestore ${emu})` : ''} — ` +
      (apply ? 'APPLY' : 'DRY RUN (nothing is written; --apply to write)'),
  );
  const summary = await migrateIndicators({ S, db }, { apply, log });
  if (!apply) log('dry run: nothing was written. Re-run with --apply to write.');
  for (const f of summary.applied.failed) log(`FAILED ${f.at}: ${f.error}`);
  return summary.applied.failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`migrate-indicators: ${e?.stack ?? e}`);
    process.exit(1);
  },
);
