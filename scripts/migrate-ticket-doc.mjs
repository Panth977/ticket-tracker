#!/usr/bin/env node
/**
 * Phase 15 data migration (docs/plan/agents.html §W) — ONE DOCUMENT PER TICKET.
 *
 * Every ticket used to fan out into four subcollections:
 *
 *   boards/{b}/tickets/{t}/messages/{id}
 *   boards/{b}/tickets/{t}/activity/{id}
 *   boards/{b}/tickets/{t}/files/{id}
 *   boards/{b}/tickets/{t}/tasklists/{id}
 *
 * They are FIELDS of the ticket now — `recentMessages`, `recentActivity`,
 * `files`, `tasklists`, plus the rollup `signals` a card renders from — with
 * anything older than the inline window spilled into
 * boards/{b}/tickets/{t}/data/{NNN}. A board open becomes one query of ten
 * documents, and opening a ticket costs nothing more.
 *
 * TWO PASSES, on purpose:
 *
 *   1. FOLD    read the subcollections, write the ticket document (and its
 *              data pages). Nothing is deleted. The app can be running: the
 *              fold is a union, so a message written either way survives.
 *   2. PRUNE   --prune: for each folded ticket, VERIFY that every
 *              subcollection document id is present in the ticket (inline or
 *              in a page) and only then delete the subcollections.
 *
 * IDEMPOTENT AND RESUMABLE. The fold stamps `migrations.p15TicketDoc` and the
 * prune stamps `migrations.p15TicketDocPruned`; a pruned ticket is never
 * folded again (folding it from empty subcollections would erase the thread),
 * and a ticket already in §W shape with empty subcollections is skipped. Both
 * passes may be interrupted and re-run. The production project has a handful
 * of boards; running the whole thing twice must be — and is — a no-op.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply.
 *
 *   node scripts/migrate-ticket-doc.mjs                      # dry run: what the fold would do
 *   node scripts/migrate-ticket-doc.mjs --apply              # pass 1: fold
 *   node scripts/migrate-ticket-doc.mjs --prune              # dry run: what the prune would delete
 *   node scripts/migrate-ticket-doc.mjs --prune --apply      # pass 2: delete the subcollections
 *   node scripts/migrate-ticket-doc.mjs --apply --board <boardId>   # one board
 *   node scripts/migrate-ticket-doc.mjs --apply --project <id>
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/migrate-ticket-doc.mjs --apply --project demo-taskmanager
 *
 * Exit code 0 = the pass finished and verified; non-zero = it stopped, and
 * nothing is half-written (each ticket is one atomic batch).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PROJECT } from './deploy-functions.mjs';

// firebase-admin and @tm/shared are dependencies of the FUNCTIONS package, not
// of the repo root — resolve them from there so this runs with plain `node`.
const requireFromBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const fromBackend = (spec) => pathToFileURL(requireFromBackend.resolve(spec)).href;
const { initializeApp, getApps } = await import(fromBackend('firebase-admin/app'));
const { getFirestore } = await import(fromBackend('firebase-admin/firestore'));
// The SAME fold the command layer performs, so a migrated ticket and a
// freshly written one are byte-for-byte the same shape.
const { docBytes, oldestOf, pageId, planSpill, questionRollup, signalsOf, tasklistRollup } =
  await import(fromBackend('@tm/shared'));

const argv = process.argv.slice(2);
let project = process.env.TM_DEPLOY_PROJECT || DEFAULT_PROJECT;
let apply = false;
let prune = false;
let limit = Infinity;
let board = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-P') project = argv[++i];
  else if (a.startsWith('--project=')) project = a.slice('--project='.length);
  else if (a === '--apply') apply = true;
  else if (a === '--prune') prune = true;
  else if (a === '--dry-run' || a === '-n') apply = false;
  else if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length));
  else if (a === '--board') board = argv[++i];
  else if (a.startsWith('--board=')) board = a.slice('--board='.length);
  else {
    console.error(`migrate-ticket-doc: unknown argument ${a}`);
    process.exit(2);
  }
}

// No GCE metadata server locally: skip the Admin SDK's credential probe.
process.env.METADATA_SERVER_DETECTION ||= 'none';

const log = (m) => console.log(`\x1b[34mticket-doc\x1b[0m │ ${m}`);
const FOLDED = 'migrations.p15TicketDoc';
const PRUNED = 'migrations.p15TicketDocPruned';
const SUBS = ['messages', 'activity', 'files', 'tasklists'];
/** Firestore's hard limit is 500 writes per batch. */
const DELETES_PER_BATCH = 400;

const rows = async (ref, name) => {
  const snap = await ref.collection(name).get();
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
};

/** Merge by id, preferring what the ticket document already holds. */
function mergeById(existing, incoming) {
  const out = new Map();
  for (const r of incoming) out.set(r.id, r);
  for (const r of existing) out.set(r.id, r);
  return [...out.values()];
}

/** Every message / activity row the ticket document already carries. */
async function alreadyFolded(ref, ticket) {
  const messages = [...(ticket.recentMessages ?? [])];
  const activity = [...(ticket.recentActivity ?? [])];
  for (let n = 0; n < (ticket.pageCount ?? 0); n++) {
    const page = await ref.collection('data').doc(pageId(n)).get();
    if (!page.exists) continue;
    messages.push(...(page.get('messages') ?? []));
    activity.push(...(page.get('activity') ?? []));
  }
  return { messages, activity };
}

/**
 * The ticket as §W wants it: the inline window, the spill, and every rollup
 * recomputed from the rows themselves rather than trusted from the old
 * counters (a counter that drifted is exactly what this fixes).
 */
function fold(ticket, all, now) {
  const byTime = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const messages = [...all.messages].sort(byTime);
  const activity = [...all.activity].sort(byTime);
  const files = [...all.files].sort((a, b) => a.createdAt - b.createdAt);
  const tasklists = [...all.tasklists].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt,
  );
  const live = files.filter((f) => f.deletedAt === null);
  const said = messages.filter((m) => m.kind !== 'system');
  const q = questionRollup(messages, now, ticket.waitingOn ?? null);
  const tl = tasklistRollup(tasklists);

  const staged = {
    ...ticket,
    counts: {
      messages: messages.length,
      files: live.length,
      pinned: messages.filter((m) => m.pinnedAt != null && m.deletedAt === null).length,
    },
    lastMessageAt: said.length ? said[said.length - 1].createdAt : null,
    waitingOn: q.waitingOn,
    nextQuestionExpiresAt: q.nextQuestionExpiresAt,
    tasklistProgress: tl ? { done: tl.done, total: tl.total } : null,
    tasklists,
    files,
    fileIds: live.map((f) => f.id),
    recentMessages: messages,
    recentActivity: activity,
  };
  // The budget is the WHOLE document's, so weigh everything but the two
  // arrays that can move out of it — exactly as TicketWriter.commit does.
  const fixed = docBytes({ ...staged, recentMessages: [], recentActivity: [] });
  const spill = planSpill(messages, activity, fixed, 0, now);
  const next = {
    ...staged,
    recentMessages: spill.messages,
    recentActivity: spill.activity,
    pageCount: spill.pages.length,
    oldestInlineAt: oldestOf(spill.messages, spill.activity),
  };
  return { fields: { ...next, signals: signalsOf(next) }, pages: spill.pages };
}

/** Every ticket, or just one board's (handy in tests and for a staged rollout). */
const tickets = (db) =>
  board ? db.collection(`boards/${board}/tickets`).get() : db.collectionGroup('tickets').get();

async function pass1(db) {
  const snap = await tickets(db);
  log(`${snap.size} ticket(s)`);
  let folded = 0;
  let skipped = 0;
  let pages = 0;
  for (const d of snap.docs.slice(0, limit)) {
    const ticket = d.data();
    if (ticket.migrations?.p15TicketDocPruned) {
      skipped++;
      continue; // folded AND pruned: folding it again would read empty subcollections
    }
    const [messages, activity, files, tasklists] = await Promise.all(
      SUBS.map((name) => rows(d.ref, name)),
    );
    const old = messages.length + activity.length + files.length + tasklists.length;
    if (old === 0 && ticket.signals !== undefined) {
      skipped++;
      continue; // already in §W shape and nothing left behind
    }
    const held = await alreadyFolded(d.ref, ticket);
    // Already folded and nothing new arrived in the old collections: a skip,
    // so running the pass twice reports (and writes) nothing.
    if (ticket.migrations?.p15TicketDoc) {
      const have = {
        messages: new Set(held.messages.map((m) => m.id)),
        activity: new Set(held.activity.map((a) => a.id)),
        files: new Set((ticket.files ?? []).map((f) => f.id)),
        tasklists: new Set((ticket.tasklists ?? []).map((l) => l.id)),
      };
      const outstanding = { messages, activity, files, tasklists };
      if (SUBS.every((k) => outstanding[k].every((r) => have[k].has(r.id)))) {
        skipped++;
        continue;
      }
    }
    const all = {
      // A union, so running this while the app is up cannot lose a message.
      messages: mergeById(held.messages, messages),
      activity: mergeById(held.activity, activity),
      files: mergeById(ticket.files ?? [], files),
      tasklists: mergeById(ticket.tasklists ?? [], tasklists),
    };
    const now = Date.now();
    const { fields, pages: plan } = fold(ticket, all, now);

    if (!apply) {
      log(
        `  would fold ${ticket.key ?? d.id}: ${all.messages.length} message(s), ` +
          `${all.activity.length} activity, ${all.files.length} file(s), ` +
          `${all.tasklists.length} list(s) → ${fields.recentMessages.length} inline + ${plan.length} page(s)`,
      );
      folded++;
      pages += plan.length;
      continue;
    }

    // One atomic batch per ticket: the pages, then the ticket that names them.
    const batch = db.batch();
    for (const p of plan) batch.set(d.ref.collection('data').doc(pageId(p.page)), p.doc);
    // A re-fold can produce FEWER pages than last time; the extras must go.
    for (let n = plan.length; n < (ticket.pageCount ?? 0); n++)
      batch.delete(d.ref.collection('data').doc(pageId(n)));
    batch.update(d.ref, {
      counts: fields.counts,
      lastMessageAt: fields.lastMessageAt,
      waitingOn: fields.waitingOn,
      nextQuestionExpiresAt: fields.nextQuestionExpiresAt,
      tasklistProgress: fields.tasklistProgress,
      tasklists: fields.tasklists,
      files: fields.files,
      fileIds: fields.fileIds,
      recentMessages: fields.recentMessages,
      recentActivity: fields.recentActivity,
      pageCount: fields.pageCount,
      oldestInlineAt: fields.oldestInlineAt,
      signals: fields.signals,
      [FOLDED]: now,
    });
    await batch.commit();
    folded++;
    pages += plan.length;
    if (folded % 25 === 0) log(`folded ${folded}…`);
  }
  log(
    `${apply ? 'folded' : 'would fold'} ${folded} ticket(s) (${pages} data page(s)), skipped ${skipped}`,
  );
  return 0;
}

async function pass2(db) {
  const snap = await tickets(db);
  let pruned = 0;
  let deleted = 0;
  let unverified = 0;
  for (const d of snap.docs.slice(0, limit)) {
    const ticket = d.data();
    if (!ticket.migrations?.p15TicketDoc) continue; // never folded: leave it alone
    const [messages, activity, files, tasklists] = await Promise.all(
      SUBS.map((name) => rows(d.ref, name)),
    );
    const old = { messages, activity, files, tasklists };
    const total = SUBS.reduce((n, k) => n + old[k].length, 0);
    if (total === 0) {
      if (apply && !ticket.migrations?.p15TicketDocPruned)
        await d.ref.update({ [PRUNED]: Date.now() });
      continue;
    }

    // VERIFY before deleting: every old document id must be in the ticket.
    const held = await alreadyFolded(d.ref, ticket);
    const inTicket = {
      messages: new Set(held.messages.map((m) => m.id)),
      activity: new Set(held.activity.map((a) => a.id)),
      files: new Set((ticket.files ?? []).map((f) => f.id)),
      tasklists: new Set((ticket.tasklists ?? []).map((l) => l.id)),
    };
    const missing = SUBS.flatMap((k) =>
      old[k].filter((r) => !inTicket[k].has(r.id)).map((r) => `${k}/${r.id}`),
    );
    if (missing.length) {
      unverified++;
      console.error(
        `migrate-ticket-doc: ${ticket.key ?? d.id} is NOT fully folded ` +
          `(${missing.length} missing, e.g. ${missing[0]}) — run the fold again before pruning`,
      );
      continue;
    }

    if (!apply) {
      log(`  would delete ${total} old document(s) under ${ticket.key ?? d.id}`);
      pruned++;
      deleted += total;
      continue;
    }
    const refs = SUBS.flatMap((k) => old[k].map((r) => d.ref.collection(k).doc(r.id)));
    for (let i = 0; i < refs.length; i += DELETES_PER_BATCH) {
      const batch = db.batch();
      for (const ref of refs.slice(i, i + DELETES_PER_BATCH)) batch.delete(ref);
      await batch.commit();
    }
    await d.ref.update({ [PRUNED]: Date.now() });
    pruned++;
    deleted += total;
  }
  log(
    `${apply ? 'pruned' : 'would prune'} ${pruned} ticket(s), ${deleted} old document(s)` +
      (unverified ? `, ${unverified} NOT verified` : ''),
  );
  return unverified ? 1 : 0;
}

async function main() {
  const app = getApps()[0] ?? initializeApp({ projectId: project });
  const db = getFirestore(app);
  log(
    `project ${project}${process.env.FIRESTORE_EMULATOR_HOST ? ' (emulator)' : ''} — ` +
      `${prune ? 'pass 2: prune' : 'pass 1: fold'}${apply ? '' : ' (DRY RUN — pass --apply to write)'}`,
  );
  return prune ? pass2(db) : pass1(db);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\x1b[31mticket-doc\x1b[0m │ ${err?.stack ?? err}`);
    process.exit(1);
  },
);
