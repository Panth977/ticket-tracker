#!/usr/bin/env node
/**
 * REPAIR MEMORY PATHS (docs/plan/memory.html §A) — put back nodes a folder
 * move left behind.
 *
 * Until the fix to readSubtree (backend/src/memory/nodes.ts), moving or
 * deleting a folder found its contents with `path < 'folder/'`, and
 * Firestore compares strings by UTF-8 bytes: a name starting with an emoji (or
 * anything else above U+F8FF) sorted past that bound. Such a node kept its OLD
 * path while its folder moved — shown at the top of the tree, missing from
 * every folder view.
 *
 * A node's `parentId` was never wrong (a move keeps ids), so the true path is
 * the parent chain's: parent.path + '/' + name. This rewrites `path` wherever it
 * differs, and reports what it cannot fix (a parent that no longer exists — the
 * folder was deleted — or two nodes that would share one path).
 *
 * DRY RUN BY DEFAULT; --apply writes. Idempotent.
 *
 *   node scripts/repair-memory-paths.mjs --project <id> [--memory <memoryId>]          # dry run
 *   node scripts/repair-memory-paths.mjs --project <id> [--memory <memoryId>] --apply  # write
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8380 node scripts/repair-memory-paths.mjs --project demo-taskmanager
 *
 * Credentials: application-default (`gcloud auth application-default login`),
 * or the emulator when FIRESTORE_EMULATOR_HOST is set. --project is REQUIRED.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
let project = '';
let only = '';
let apply = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-P') project = argv[++i] ?? '';
  else if (a.startsWith('--project=')) project = a.slice('--project='.length);
  else if (a === '--memory') only = argv[++i] ?? '';
  else if (a.startsWith('--memory=')) only = a.slice('--memory='.length);
  else if (a === '--apply') apply = true;
  else if (a === '--dry-run' || a === '-n') apply = false;
  else {
    console.error(`repair-memory-paths: unknown argument ${a}`);
    process.exit(2);
  }
}
if (!project) {
  console.error(
    'repair-memory-paths: --project <id> is required (it never guesses which database)',
  );
  process.exit(2);
}
process.env.GCLOUD_PROJECT = project;
process.env.GOOGLE_CLOUD_PROJECT = project;
process.env.METADATA_SERVER_DETECTION ||= 'none';

// firebase-admin is the backend's dependency.
const require = createRequire(fileURLToPath(new URL('../backend/package.json', import.meta.url)));
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { gcloudCredential, gcloudClients } = await import('./lib/gcloud-credential.mjs');
initializeApp(
  process.env.FIRESTORE_EMULATOR_HOST
    ? { projectId: project }
    : { projectId: project, credential: gcloudCredential() ?? applicationDefault() },
);
// On a gcloud account (TM_GCLOUD_ACCOUNT), the Cloud client directly — see lib/gcloud-credential.mjs.
const g = gcloudClients(project, {
  createRequire,
  adminEntry: require.resolve('firebase-admin/firestore'),
});
const db = g ? g.db : getFirestore();
const log = (m = '') => console.log(`\x1b[34mrepair\x1b[0m │ ${m}`);

/**
 * Pure: every node whose path disagrees with its parent chain.
 * @param {{ id: string, parentId: string | null, name: string, path: string }[]} nodes
 */
export function planPathRepairs(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map();
  /** @returns {string | null} null = the chain is broken (missing parent, or a cycle) */
  function truePath(n, seen = new Set()) {
    if (memo.has(n.id)) return memo.get(n.id);
    if (seen.has(n.id)) return null;
    seen.add(n.id);
    let p;
    if (n.parentId === null) p = n.name;
    else {
      const parent = byId.get(n.parentId);
      const pp = parent && parent.kind === 'folder' ? truePath(parent, seen) : null;
      p = pp === null ? null : `${pp}/${n.name}`;
    }
    memo.set(n.id, p);
    return p;
  }
  const fixes = [];
  const broken = [];
  for (const n of nodes) {
    const p = truePath(n);
    if (p === null) broken.push(n);
    else if (p !== n.path) fixes.push({ id: n.id, from: n.path, to: p });
  }
  // A fix must not land on a path another node keeps (or another fix takes).
  const final = new Map(nodes.map((n) => [n.id, n.path]));
  for (const f of fixes) final.set(f.id, f.to);
  const count = new Map();
  for (const p of final.values()) count.set(p, (count.get(p) ?? 0) + 1);
  const clashes = fixes.filter((f) => count.get(f.to) > 1);
  return { fixes: fixes.filter((f) => count.get(f.to) === 1), clashes, broken };
}

async function main() {
  const where = process.env.FIRESTORE_EMULATOR_HOST
    ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})`
    : '';
  log(
    `project ${project}${where} — ${apply ? 'APPLY' : 'dry run (nothing is written; --apply to write)'}`,
  );
  const memories = only
    ? [await db.doc(`memories/${only}`).get()]
    : (await db.collection('memories').get()).docs;
  let total = 0;
  for (const m of memories) {
    if (!m.exists) {
      log(`memories/${m.id}: not found`);
      continue;
    }
    const snap = await m.ref.collection('nodes').get();
    const nodes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const { fixes, clashes, broken } = planPathRepairs(nodes);
    if (!fixes.length && !clashes.length && !broken.length) continue;
    log(`memories/${m.id} "${m.get('name')}": ${nodes.length} nodes`);
    for (const f of fixes) log(`  fix    ${f.from}  →  ${f.to}`);
    for (const f of clashes) log(`  CLASH  ${f.from}  →  ${f.to} (taken — left alone)`);
    for (const b of broken)
      log(
        `  BROKEN ${b.path} (its parent ${b.parentId} is gone — left alone; move or delete it in the app)`,
      );
    total += fixes.length;
    if (apply && fixes.length) {
      for (let i = 0; i < fixes.length; i += 400) {
        const batch = db.batch();
        for (const f of fixes.slice(i, i + 400))
          batch.update(m.ref.collection('nodes').doc(f.id), { path: f.to });
        await batch.commit();
      }
      log(`  wrote ${fixes.length}`);
    }
  }
  if (!total) log('nothing to repair');
  else if (!apply)
    log(`dry run: ${total} path(s) would be repaired. Re-run with --apply to write.`);
  else log(`done: ${total} path(s) repaired.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
