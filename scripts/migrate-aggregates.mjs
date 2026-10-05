#!/usr/bin/env node
/**
 * aggregates.html §M data migration — COST BECOMES AN AGGREGATE FIELD.
 *
 * For every board (archived ones too):
 *   · aggFields ||= [COST_AGG_FIELD] ('Cost', '$', daily, on cards); a list
 *     without 'cost' gets it first; a list WITH 'cost' (even archived) is left alone;
 *   · board.aggs.cost = { total: cost.usd, count: cost.runs };
 *   · every ticket with cost → ticket.aggs.cost likewise, and every message with
 *     a `run` (inline and in data pages) gets agg = { entries: [{ fieldId:
 *     'cost', value: run.costUsd }] } when it has none;
 *   · every boards/{b}/stats/{day} → aggStats 'daily:{day}' fields.cost =
 *     { total, count, tickets: { KEY: { total, count } } } — other fields in
 *     that doc are kept.
 *
 * The legacy counters are the full truth for 'cost' (the backend still writes
 * them), so an aggregate counter that differs is corrected from them and
 * listed. The logic is scripts/lib/aggregates.mjs (unit + emulator tested).
 * Nothing is deleted: board.cost, ticket.cost and stats/{day} stay.
 *
 * DRY RUN BY DEFAULT: prints the plan, writes nothing. --apply writes.
 * IDEMPOTENT: values are compared, so a re-run writes nothing.
 *
 *   pnpm --filter @tm/shared build
 *   node scripts/migrate-aggregates.mjs --project <id>            # dry run
 *   node scripts/migrate-aggregates.mjs --project <id> --apply    # write
 *
 * Credentials: application-default, or TM_GCLOUD_ACCOUNT=<you@…> (the gcloud
 * CLI's account, lib/gcloud-credential.mjs), or the emulator when
 * FIRESTORE_EMULATOR_HOST is set. --project is REQUIRED: this script never
 * guesses which database it changes.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { migrateAggregates } from './lib/aggregates.mjs';

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
    console.error(`migrate-aggregates: unknown argument ${a}`);
    process.exit(2);
  }
}
if (!project) {
  console.error('migrate-aggregates: --project <id> is required');
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
if (typeof S.aggStatsId !== 'function' || !S.COST_AGG_FIELD) {
  console.error('migrate-aggregates: shared/dist is stale. Run: pnpm --filter @tm/shared build');
  process.exit(2);
}

const log = (m = '') => console.log(`\x1b[34maggregates\x1b[0m │ ${m}`);

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
  const summary = await migrateAggregates({ S, db }, { apply, log });
  if (!apply) log('dry run: nothing was written. Re-run with --apply to write.');
  return summary.applied.failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`migrate-aggregates: ${e?.stack ?? e}`);
    process.exit(1);
  },
);
