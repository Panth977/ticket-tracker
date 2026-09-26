#!/usr/bin/env node
/**
 * Phase 16 data migration (docs/plan/agents.html §X) — THE ALLOW LIST, for a
 * database that predates it.
 *
 * From the moment the new rules and middleware are live, only accounts on
 * `_config/allow` can do anything. Nobody who is already using this tracker
 * may be locked out by that, so before (or right after) the deploy:
 *
 *   _config/allow          = every EXISTING account's address, added by
 *                            'migration' — plus the admin, who is on the list
 *                            by definition and is not stored as a row.
 *   users/{uid}.allowed    = true for every existing profile (the mirror the
 *                            security rules read in one hop).
 *
 * A soft-deleted account (accountDelete: deletedAt set, address cleared) is
 * NOT re-allowed — there is nobody there to allow.
 *
 * IDEMPOTENT: it adds addresses that are missing and sets flags that are not
 * yet true, and answers "nothing to do" on a second run. It never REMOVES
 * anyone — taking access away is the admin's job, in the Users module.
 *
 *   node scripts/migrate-allow-list.mjs --dry-run
 *   node scripts/migrate-allow-list.mjs --project <id>
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8380 node scripts/migrate-allow-list.mjs --project demo-taskmanager
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PROJECT } from './deploy-functions.mjs';

const requireFromBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const adminUrl = (sub) => pathToFileURL(requireFromBackend.resolve(`firebase-admin/${sub}`)).href;
const { initializeApp, getApps } = await import(adminUrl('app'));
const { getFirestore } = await import(adminUrl('firestore'));

const argv = process.argv.slice(2);
let project = process.env.TM_DEPLOY_PROJECT || DEFAULT_PROJECT;
let dryRun = false;
/** Kept in step with shared/src/config.ts (DEFAULT_ADMIN_EMAIL, ALLOW_DOC). */
let admin = (process.env.TM_ADMIN_EMAIL || '').trim().toLowerCase();
const ALLOW_DOC = '_config/allow';

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-P') project = argv[++i];
  else if (a.startsWith('--project=')) project = a.slice('--project='.length);
  else if (a === '--admin') admin = argv[++i].trim().toLowerCase();
  else if (a.startsWith('--admin=')) admin = a.slice('--admin='.length).trim().toLowerCase();
  else if (a === '--dry-run' || a === '-n') dryRun = true;
  else {
    console.error(`migrate-allow-list: unknown argument ${a}`);
    process.exit(2);
  }
}

process.env.METADATA_SERVER_DETECTION ||= 'none';
const log = (m) => console.log(`\x1b[34mmigrate\x1b[0m │ ${m}`);

async function main() {
  const app = getApps()[0] ?? initializeApp({ projectId: project });
  const db = getFirestore(app);
  log(`project ${project}${process.env.FIRESTORE_EMULATOR_HOST ? ' (emulator)' : ''}${dryRun ? ' — dry run' : ''}`);
  log(`admin ${admin} (allowed by definition, never stored as a row)`);

  const users = await db.collection('users').get();
  const now = Date.now();
  const current = (await db.doc(ALLOW_DOC).get()).data() ?? { emails: [], updatedAt: 0 };
  const have = new Set((current.emails ?? []).map((e) => String(e.email).toLowerCase()));

  const add = [];
  const flag = [];
  for (const doc of users.docs) {
    const email = String(doc.get('email') ?? '').trim().toLowerCase();
    const deleted = doc.get('deletedAt');
    if (deleted) continue; // nobody there to allow
    if (doc.get('allowed') !== true) flag.push(doc.ref);
    if (!email || email === admin || have.has(email)) continue;
    have.add(email);
    add.push({ email, addedAt: now, addedBy: 'migration' });
  }

  log(`${users.size} profile(s): ${add.length} address(es) to add, ${flag.length} mirror flag(s) to set`);
  if (dryRun) {
    for (const e of add) log(`  would allow ${e.email}`);
    for (const r of flag) log(`  would set allowed=true on ${r.path}`);
    return 0;
  }
  if (!add.length && !flag.length) {
    log('nothing to do — every existing account is already allowed');
    return 0;
  }

  if (add.length || !current.updatedAt) {
    await db.doc(ALLOW_DOC).set({
      emails: [...(current.emails ?? []), ...add],
      updatedAt: now,
    });
    log(`_config/allow now names ${(current.emails ?? []).length + add.length} address(es)`);
  }
  for (let i = 0; i < flag.length; i += 400) {
    const batch = db.batch();
    for (const ref of flag.slice(i, i + 400)) batch.set(ref, { allowed: true }, { merge: true });
    await batch.commit();
    log(`mirrored ${Math.min(i + 400, flag.length)}/${flag.length}`);
  }
  log('done — every existing account can still use the app');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\x1b[31mmigrate\x1b[0m │ ${err?.stack ?? err}`);
    process.exit(1);
  },
);
