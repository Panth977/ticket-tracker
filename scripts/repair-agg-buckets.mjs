#!/usr/bin/env node
/**
 * REPAIR AGGREGATE BUCKETS (docs/plan/aggregates.html) — rebuild a board's
 * period buckets (boards/{b}/aggStats) from its messages, and date entries
 * that were posted later than the day they are for.
 *
 * Before `agg.at` existed, a log backfilled today for Monday was bucketed
 * TODAY. This script:
 *   1. --at <messageId>=<YYYY-MM-DD | ISO | millis>   (repeatable)
 *      records what those messages' entries are FOR (message.agg.at);
 *   2. recomputes, for the chosen fields, every bucket from every agg entry on
 *      the board's tickets (recentMessages + spilled data pages), each at
 *      agg.at ?? createdAt — and writes only those fields of each bucket
 *      (other fields untouched; a bucket left with no fields is deleted).
 * Ticket and board TOTALS don't depend on dates and are left as they are.
 *
 * Fields: --fields a_x,a_y (default: every field EXCEPT cost — Cost's older
 * history came from the legacy day stats, not from messages).
 *
 * DRY RUN BY DEFAULT; --apply writes. Idempotent.
 *
 *   TM_GCLOUD_ACCOUNT=you@x node scripts/repair-agg-buckets.mjs --project <id> --board HEA \
 *     --at <messageId>=2026-10-04 [--fields a_prot01] [--apply]
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
let project = '';
let boardKey = '';
let apply = false;
let fieldsArg = '';
const ats = new Map();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => argv[++i] ?? '';
  if (a === '--project') project = val();
  else if (a === '--board') boardKey = val();
  else if (a === '--fields') fieldsArg = val();
  else if (a === '--apply') apply = true;
  else if (a === '--dry-run') apply = false;
  else if (a === '--at') {
    const [id, when] = val().split('=');
    if (!id || !when) throw new Error(`--at wants <messageId>=<date>, got ${argv[i]}`);
    ats.set(id, when);
  } else {
    console.error(`repair-agg-buckets: unknown argument ${a}`);
    process.exit(2);
  }
}
if (!project || !boardKey) {
  console.error('repair-agg-buckets: --project and --board are required');
  process.exit(2);
}
process.env.GCLOUD_PROJECT = project;
process.env.GOOGLE_CLOUD_PROJECT = project;
process.env.METADATA_SERVER_DETECTION ||= 'none';

const req = createRequire(new URL('../backend/package.json', import.meta.url));
const from = (spec) => pathToFileURL(req.resolve(spec)).href;
const S = await import(from('@tm/shared'));
if (typeof S.aggAtFrom !== 'function') {
  console.error('repair-agg-buckets: shared/dist is stale. Run: pnpm --filter @tm/shared build');
  process.exit(2);
}
const { gcloudClients } = await import('./lib/gcloud-credential.mjs');
let db;
const g = gcloudClients(project, {
  createRequire,
  adminEntry: req.resolve('firebase-admin/firestore'),
});
if (g) db = g.db;
else {
  const { initializeApp, applicationDefault } = await import(from('firebase-admin/app'));
  const { getFirestore } = await import(from('firebase-admin/firestore'));
  initializeApp(
    process.env.FIRESTORE_EMULATOR_HOST
      ? { projectId: project }
      : { projectId: project, credential: applicationDefault() },
  );
  db = getFirestore();
}
const log = (m = '') => console.log(`\x1b[34magg-buckets\x1b[0m │ ${m}`);

const boards = await db.collection('boards').where('key', '==', boardKey).get();
if (boards.empty) throw new Error(`No board ${boardKey}`);
const board = boards.docs[0];
const defs = (board.get('aggFields') ?? []).filter(Boolean);
const wanted = fieldsArg
  ? fieldsArg.split(',').map((s) => s.trim())
  : defs.filter((f) => f.id !== S.COST_AGG_FIELD_ID).map((f) => f.id);
const byId = new Map(defs.map((f) => [f.id, f]));
for (const f of wanted) if (!byId.has(f)) throw new Error(`No aggregate field ${f} on ${boardKey}`);
log(`project ${project} — board ${boardKey} (${board.id}) — ${apply ? 'APPLY' : 'DRY RUN'}`);
log(`fields: ${wanted.map((f) => `${byId.get(f).label} (${byId.get(f).period})`).join(', ')}`);

// ── 1. every message with agg entries, where it lives ────────────────────────
/** @type {{ ref: any, where: 'recent' | 'page', index: number, ticketKey: string, msg: any }[]} */
const found = [];
const tickets = await board.ref.collection('tickets').get();
for (const t of tickets.docs) {
  const key = t.get('key');
  (t.get('recentMessages') ?? []).forEach((m, index) => {
    if (m.agg?.entries?.length)
      found.push({ ref: t.ref, where: 'recent', index, ticketKey: key, msg: m });
  });
  const pages = await t.ref.collection('data').get();
  for (const p of pages.docs)
    (p.get('messages') ?? []).forEach((m, index) => {
      if (m.agg?.entries?.length)
        found.push({ ref: p.ref, where: 'page', index, ticketKey: key, msg: m });
    });
}

// ── 2. the dates to record ──────────────────────────────────────────────────
const dating = [];
for (const [id, when] of ats) {
  const f = found.find((x) => x.msg.id === id);
  if (!f) throw new Error(`No agg message ${id} on ${boardKey}`);
  const at = S.aggAtFrom(/^\d+$/.test(when) ? Number(when) : when);
  if (at === null) throw new Error(`Can't read the date ${when}`);
  if (f.msg.agg.at !== at) dating.push({ f, at });
  f.msg = { ...f.msg, agg: { ...f.msg.agg, at } };
}
for (const { f, at } of dating)
  log(
    `date   ${f.ticketKey} ${f.msg.id}: posted ${new Date(f.msg.createdAt).toISOString()} → for ${new Date(at).toISOString()}`,
  );

// ── 3. the buckets as they should be ────────────────────────────────────────
/** docId → fieldId → { total, count, tickets } */
const want = new Map();
for (const { msg, ticketKey } of found) {
  const at = msg.agg.at ?? msg.createdAt;
  for (const e of msg.agg.entries) {
    if (!wanted.includes(e.fieldId)) continue;
    const def = byId.get(e.fieldId);
    const id = S.aggStatsId(def.period, S.aggPeriodKey(def.period, at));
    const doc = want.get(id) ?? new Map();
    const cur = doc.get(e.fieldId) ?? { total: 0, count: 0, tickets: {} };
    cur.total = S.roundAgg(cur.total + e.value);
    cur.count += 1;
    const t = cur.tickets[ticketKey] ?? { total: 0, count: 0 };
    cur.tickets[ticketKey] = { total: S.roundAgg(t.total + e.value), count: t.count + 1 };
    doc.set(e.fieldId, cur);
    want.set(id, doc);
  }
}

// ── 4. compare with what is stored ─────────────────────────────────────────
const stored = await board.ref.collection('aggStats').get();
const ids = new Set([...stored.docs.map((d) => d.id), ...want.keys()]);
const writes = [];
for (const id of [...ids].sort()) {
  const have = stored.docs.find((d) => d.id === id)?.data() ?? null;
  const next = { ...(have?.fields ?? {}) };
  for (const f of wanted) delete next[f];
  for (const [f, v] of want.get(id) ?? []) next[f] = v;
  const same = JSON.stringify(sortKeys(have?.fields ?? {})) === JSON.stringify(sortKeys(next));
  if (same) continue;
  const [period, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  const summary = wanted
    .map((f) => {
      const a = have?.fields?.[f]?.total ?? 0;
      const b = next[f]?.total ?? 0;
      return a === b ? null : `${byId.get(f).label} ${a} → ${b}`;
    })
    .filter(Boolean)
    .join(', ');
  log(`bucket ${id}: ${summary}${Object.keys(next).length ? '' : ' (now empty — deleted)'}`);
  writes.push({ id, period, key, next, empty: !Object.keys(next).length });
}
function sortKeys(o) {
  if (Array.isArray(o) || o === null || typeof o !== 'object') return o;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, sortKeys(o[k])]),
  );
}

if (!dating.length && !writes.length) {
  log('nothing to repair');
  process.exit(0);
}
if (!apply) {
  log(
    `dry run: ${dating.length} message(s) to date, ${writes.length} bucket(s) to rewrite. --apply to write.`,
  );
  process.exit(0);
}

// ── 5. write ────────────────────────────────────────────────────────────────
const now = Date.now();
for (const { f, at } of dating) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(f.ref);
    const field = f.where === 'recent' ? 'recentMessages' : 'messages';
    const list = [...(snap.get(field) ?? [])];
    const i = list.findIndex((m) => m.id === f.msg.id);
    if (i < 0) throw new Error(`${f.msg.id} moved while repairing — re-run`);
    list[i] = { ...list[i], agg: { ...list[i].agg, at } };
    tx.update(f.ref, { [field]: list });
  });
}
const batch = db.batch();
for (const w of writes) {
  const ref = board.ref.collection('aggStats').doc(w.id);
  if (w.empty) batch.delete(ref);
  else batch.set(ref, { period: w.period, key: w.key, fields: w.next, updatedAt: now });
}
await batch.commit();
log(`done: ${dating.length} message(s) dated, ${writes.length} bucket(s) rewritten.`);
