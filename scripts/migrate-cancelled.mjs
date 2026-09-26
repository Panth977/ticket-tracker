#!/usr/bin/env node
/**
 * Phase 6 data migration — the ticket state 'cancelled' no longer exists.
 *
 * A ticket is active or archived; 'Cancel ticket' became 'Delete ticket'
 * (permanent, one confirm, no reason). Every ticket still stored as
 * 'cancelled' becomes 'archived' — the closest surviving state: read-only,
 * out of every default view, and restorable by an admin.
 *
 * Each migrated ticket gets:
 *   - state: 'archived' (updatedAt / lastActivityAt left ALONE: this is not a
 *     human edit and must not reorder anyone's 'recently updated' list)
 *   - one activity row, action 'state', via 'system', actor null, with
 *     changes { state: { from: 'cancelled', to: 'archived' } }
 *   - one system line in the thread: 'state simplified: cancelled → archived'
 *     (counts.messages +1, lastMessageAt untouched — a state change never
 *     marks the thread unread, same rule as writeStateChange)
 *
 * IDEMPOTENT: it only ever touches tickets whose stored state is exactly
 * 'cancelled', and it stamps `migrations.p6CancelledToArchived` on each one,
 * so a second (or interrupted-then-resumed) run is a no-op. Safe to run
 * before the deploy, after it, or twice.
 *
 *   node scripts/migrate-cancelled.mjs --dry-run            # count only, no writes
 *   node scripts/migrate-cancelled.mjs                      # default project
 *   node scripts/migrate-cancelled.mjs --project <id>
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/migrate-cancelled.mjs --project demo-taskmanager
 *
 * Exit code 0 = nothing left in 'cancelled'; non-zero = it failed and nothing
 * is guaranteed migrated (re-run it — see IDEMPOTENT above).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PROJECT } from './deploy-functions.mjs';

// firebase-admin is a dependency of the FUNCTIONS package, not of the repo
// root — resolve it from there so this script runs with plain `node`.
const requireFromBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const adminUrl = (sub) => pathToFileURL(requireFromBackend.resolve(`firebase-admin/${sub}`)).href;
const { initializeApp, getApps } = await import(adminUrl('app'));
const { getFirestore, FieldValue } = await import(adminUrl('firestore'));

const argv = process.argv.slice(2);
let project = process.env.TM_DEPLOY_PROJECT || DEFAULT_PROJECT;
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-P') project = argv[++i];
  else if (a.startsWith('--project=')) project = a.slice('--project='.length);
  else if (a === '--dry-run' || a === '-n') dryRun = true;
  else {
    console.error(`migrate-cancelled: unknown argument ${a}`);
    process.exit(2);
  }
}

// No GCE metadata server locally: skip the Admin SDK's credential probe.
process.env.METADATA_SERVER_DETECTION ||= 'none';

const log = (m) => console.log(`\x1b[34mmigrate\x1b[0m │ ${m}`);

/** The marker that makes a second run a no-op even if `state` were re-set by hand. */
const MARK = 'migrations.p6CancelledToArchived';
/** Firestore hard limit is 500 writes; each ticket costs 3 (ticket + activity + message). */
const TICKETS_PER_BATCH = 150;

/** A one-paragraph rich-text body, the shape `richFromInline` builds in the backend. */
function systemBody(text) {
  return {
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    text,
    mentions: [],
    refs: [],
  };
}

async function main() {
  const app = getApps()[0] ?? initializeApp({ projectId: project });
  const db = getFirestore(app);
  log(`project ${project}${process.env.FIRESTORE_EMULATOR_HOST ? ' (emulator)' : ''}${dryRun ? ' — dry run' : ''}`);

  // collectionGroup: tickets live under boards/{boardId}/tickets/{ticketId}.
  const snap = await db.collectionGroup('tickets').where('state', '==', 'cancelled').get();
  if (snap.empty) {
    log('no tickets in state cancelled — nothing to do');
    return 0;
  }
  log(`${snap.size} ticket(s) in state cancelled`);
  if (dryRun) {
    for (const d of snap.docs) log(`  would migrate ${d.get('key') ?? d.id} (${d.ref.path})`);
    return 0;
  }

  const now = Date.now();
  let done = 0;
  for (let i = 0; i < snap.docs.length; i += TICKETS_PER_BATCH) {
    const chunk = snap.docs.slice(i, i + TICKETS_PER_BATCH);
    const batch = db.batch();
    for (const doc of chunk) {
      batch.update(doc.ref, {
        state: 'archived',
        [MARK]: now,
        'counts.messages': FieldValue.increment(1),
      });
      batch.set(doc.ref.collection('activity').doc(), {
        action: 'state',
        changes: { state: { from: 'cancelled', to: 'archived' } },
        actor: null,
        via: 'system',
        createdAt: now,
      });
      batch.set(doc.ref.collection('messages').doc(), {
        kind: 'system',
        body: systemBody('state simplified: cancelled → archived'),
        authorUid: null,
        authorName: 'TaskManager',
        via: 'system',
        replyTo: null,
        attachments: [],
        reactions: {},
        pinnedAt: null,
        pinnedBy: null,
        editedAt: null,
        deletedAt: null,
        createdAt: now,
      });
    }
    await batch.commit();
    done += chunk.length;
    log(`migrated ${done}/${snap.size}`);
  }

  // Verify: nothing may be left behind (a ticket written while we ran would
  // show up here, and the re-run is free).
  const left = await db.collectionGroup('tickets').where('state', '==', 'cancelled').limit(1).get();
  if (!left.empty) {
    console.error('migrate-cancelled: tickets are STILL in state cancelled — run it again');
    return 1;
  }
  log('done — no ticket is in state cancelled any more');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\x1b[31mmigrate\x1b[0m │ ${err?.stack ?? err}`);
    process.exit(1);
  },
);
