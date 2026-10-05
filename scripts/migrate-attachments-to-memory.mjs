#!/usr/bin/env node
/**
 * memory.html §J data migration — TICKET ATTACHMENTS MOVE INTO ONE MEMORY.
 *
 * For a database whose tickets carry files under boards/{b}/tickets/{t}/…:
 *
 *   1. finds (or creates) the memory "<--memory-name>" (default "ticket") owned
 *      by --owner;
 *   2. grants it 'write' to EVERY board (archived ones too) and sets each
 *      board's attachMemory = { memoryId, template:
 *      'boards/<BOARDKEY>/<ticketId>/<time>_<filename>' } — stops before any
 *      write when there are more boards than MEMORY_GRANTS_MAX;
 *   3. for every live board-attachment row of every ticket: copies the object
 *      to memories/{m}/{fileId}/{name}, makes the file node (and its folders)
 *      at boards/<BOARDKEY>/<TICKETKEY>/<time>_<filename> (' (2)'… on a clash),
 *      and rewrites the ticket's files[] row AND every message attachment
 *      (inline and in data pages) with that path into a memory reference.
 *
 * The logic is scripts/lib/attachments-to-memory.mjs (unit + emulator tested).
 *
 * NOTHING IS DELETED. The old objects stay where they are (and keep serving any
 * link or thumbnail that still names them). Every copy carries custom metadata
 * `migratedFrom: <old path>`, so a later clean-up can delete EXACTLY the moved
 * originals (and their thumb_400.webp beside them) — not a blanket
 * `boards/*\/tickets/**` delete: tombstoned rows, skipped rows and old
 * activity still name objects there.
 *
 * DRY RUN BY DEFAULT: prints the plan (and 20 sample moves), writes nothing.
 * --apply writes. IDEMPOTENT: node and file ids derive from the old object
 * path, so a re-run — after a crash, or after a finished run — duplicates
 * nothing and changes nothing.
 *
 *   pnpm --filter @tm/shared build
 *   node scripts/migrate-attachments-to-memory.mjs --project <id> --owner <email>            # dry run
 *   node scripts/migrate-attachments-to-memory.mjs --project <id> --owner <email> --apply    # write
 *
 * Options: --memory-name <name> (default 'ticket'), --bucket <name> (default
 * <project>.firebasestorage.app; <project>.appspot.com for demo- projects),
 * --owner-uid <uid> (skip the Auth lookup), --sample <n>.
 *
 * Credentials: application-default (`gcloud auth application-default login`,
 * with `gcloud auth application-default set-quota-project <id>` so the Auth
 * lookup is allowed), or the emulators when FIRESTORE_EMULATOR_HOST /
 * FIREBASE_STORAGE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are set.
 * --project is REQUIRED: this script never guesses which database it changes.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { migrateAttachmentsToMemory } from './lib/attachments-to-memory.mjs';

const argv = process.argv.slice(2);
let project = '';
let owner = '';
let ownerUid = '';
let memoryName = 'ticket';
let bucketName = '';
let apply = false;
let sample = 20;
const value = (a, i, name) =>
  a.startsWith(`${name}=`) ? [a.slice(name.length + 1), i] : [argv[i + 1] ?? '', i + 1];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const is = (n) => a === n || a.startsWith(`${n}=`);
  if (is('--project') || a === '-P') [project, i] = value(a, i, '--project');
  else if (is('--owner')) [owner, i] = value(a, i, '--owner');
  else if (is('--owner-uid')) [ownerUid, i] = value(a, i, '--owner-uid');
  else if (is('--memory-name')) [memoryName, i] = value(a, i, '--memory-name');
  else if (is('--bucket')) [bucketName, i] = value(a, i, '--bucket');
  else if (is('--sample')) {
    let s;
    [s, i] = value(a, i, '--sample');
    sample = Number(s) || 20;
  } else if (a === '--apply') apply = true;
  else if (a === '--dry-run' || a === '-n') apply = false;
  else if (a === '--keep-old') {
    /* the default, and the only behaviour: old objects are never deleted */
  } else {
    console.error(`migrate-attachments-to-memory: unknown argument ${a}`);
    process.exit(2);
  }
}
if (!project) {
  console.error('migrate-attachments-to-memory: --project <id> is required');
  process.exit(2);
}
if (!owner && !ownerUid) {
  console.error('migrate-attachments-to-memory: --owner <email> is required');
  process.exit(2);
}
if (!memoryName.trim()) {
  console.error('migrate-attachments-to-memory: --memory-name cannot be empty');
  process.exit(2);
}
bucketName ||= project.startsWith('demo-')
  ? `${project}.appspot.com`
  : `${project}.firebasestorage.app`;

process.env.GCLOUD_PROJECT = project;
process.env.GOOGLE_CLOUD_PROJECT = project;
process.env.METADATA_SERVER_DETECTION ||= 'none';

// firebase-admin and @tm/shared are dependencies of the FUNCTIONS package, not
// of the repo root — resolve them from there so this runs with plain `node`.
const requireFromBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const fromBackend = (spec) => pathToFileURL(requireFromBackend.resolve(spec)).href;
const { initializeApp, getApps } = await import(fromBackend('firebase-admin/app'));
const { getFirestore, FieldValue } = await import(fromBackend('firebase-admin/firestore'));
const { getStorage } = await import(fromBackend('firebase-admin/storage'));
const { getAuth } = await import(fromBackend('firebase-admin/auth'));
const S = await import(fromBackend('@tm/shared'));
const { gcloudCredential, gcloudClients } = await import('./lib/gcloud-credential.mjs');
if (typeof S.fillAttachTemplate !== 'function') {
  console.error(
    'migrate-attachments-to-memory: shared/dist is stale. Run: pnpm --filter @tm/shared build',
  );
  process.exit(2);
}

const log = (m = '') => console.log(`\x1b[34mattach→memory\x1b[0m │ ${m}`);

async function main() {
  const credential = gcloudCredential();
  const app =
    getApps()[0] ??
    initializeApp({
      projectId: project,
      storageBucket: bucketName,
      ...(credential ? { credential } : {}),
    });
  // On a gcloud account (TM_GCLOUD_ACCOUNT), the Cloud clients directly — see lib/gcloud-credential.mjs.
  const g = gcloudClients(project, {
    createRequire,
    adminEntry: requireFromBackend.resolve('firebase-admin/firestore'),
  });
  const db = g ? g.db : getFirestore(app);
  const bucket = g ? g.storage.bucket(bucketName) : getStorage(app).bucket(bucketName);
  const emu = [
    process.env.FIRESTORE_EMULATOR_HOST && `firestore ${process.env.FIRESTORE_EMULATOR_HOST}`,
    process.env.FIREBASE_STORAGE_EMULATOR_HOST &&
      `storage ${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`,
  ].filter(Boolean);
  log(
    `project ${project}, bucket ${bucketName}${emu.length ? ` (emulator: ${emu.join(', ')})` : ''} — ` +
      (apply ? 'APPLY' : 'DRY RUN (nothing is written; --apply to write)'),
  );
  if (!ownerUid) {
    const user = await getAuth(app).getUserByEmail(owner);
    ownerUid = user.uid;
  }
  log(`owner: ${owner || '(by uid)'} → ${ownerUid}`);
  const summary = await migrateAttachmentsToMemory(
    { S, db, bucket, FieldValue },
    { ownerUid, memoryName, apply, log, sample },
  );
  if (summary.stopped) return 1;
  log('');
  if (!apply) log('dry run: nothing was written. Re-run with --apply to write.');
  else
    log(
      `memory ${summary.memoryId}. The old objects under boards/*/tickets/ were KEPT. To clean up later, ` +
        `delete only the originals named by the copies' metadata.migratedFrom (gs://${bucketName}/memories/${summary.memoryId}/mig*) ` +
        `and the thumb_400.webp beside each — never the whole prefix (tombstoned/skipped rows still point there).`,
    );
  return summary.applied.failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`migrate-attachments-to-memory: ${e?.stack ?? e}`);
    process.exit(1);
  },
);
