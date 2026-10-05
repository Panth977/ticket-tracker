/**
 * aggregates.html §M — the data migration that makes COST one aggregate field.
 *
 * Before: cost lived in its own counters — board.cost / ticket.cost
 * ({ usd, runs }) and boards/{b}/stats/{yyyy-mm-dd} ({ costUsd, runs,
 * tickets: { KEY: { usd, runs } } }), and a turn receipt was a message with
 * `run` only.
 *
 * After: every board has the aggregate field 'cost' (COST_AGG_FIELD: '$',
 * daily) and the same numbers in the aggregate shape:
 *
 *   board.aggFields            ||= [COST_AGG_FIELD]; a list without 'cost' gets it first
 *   board.aggs.cost            = { total: cost.usd, count: cost.runs }
 *   ticket.aggs.cost           = likewise, per ticket
 *   aggStats/daily:{day}       fields.cost = { total: costUsd, count: runs,
 *                                tickets: { KEY: { total: usd, count: runs } } }
 *                              (merged: other fields in that doc are kept)
 *   message.agg                = { entries: [{ fieldId: 'cost', value: run.costUsd }] }
 *                                on every message with a `run` and no `agg`
 *                                (inline and in data pages)
 *
 * The legacy counters are the FULL truth for the cost field: the backend keeps
 * writing them for every entry on 'cost' (receipt or manual) and, before this
 * migration, seeds aggs.cost from them. So a cost counter is written whenever
 * it is ABSENT or DIFFERS from the legacy one (a difference is reported as a
 * correction), and only fields.cost of an aggStats doc is replaced — any other
 * field in that doc is kept.
 *
 * IDEMPOTENT by comparing values: equal → no write. A re-run changes nothing.
 *
 * Pure planning functions first (unit-tested in qaqc/test/migrate-aggregates.test.ts);
 * migrateAggregates() is the I/O (emulator-tested in qaqc/rules/migrate-aggregates.test.ts).
 * `S` is @tm/shared, passed in so this file runs under plain node and under vitest.
 */

const sameCounter = (a, b) =>
  !!a && !!b && Math.abs((a.total ?? 0) - (b.total ?? 0)) < 1e-6 && a.count === b.count;

/** { usd, runs } → { total, count } (rounded like the backend rounds). */
export const counterFromCost = (S, c) => ({
  total: S.roundAgg(Number(c?.usd ?? 0)),
  count: Number(c?.runs ?? 0),
});

/**
 * The aggFields a board should have, or null when it already has 'cost'.
 * Absent → [COST_AGG_FIELD]; a list without 'cost' → Cost first (position
 * below the smallest), the others untouched.
 */
export function planAggFields(S, aggFields) {
  if (!Array.isArray(aggFields)) return [{ ...S.COST_AGG_FIELD }];
  if (aggFields.some((f) => f.id === S.COST_AGG_FIELD_ID)) return null;
  const min = aggFields.reduce((m, f) => Math.min(m, f.position), Infinity);
  const position = Number.isFinite(min) ? min - 1 : 0;
  return [{ ...S.COST_AGG_FIELD, position }, ...aggFields];
}

/**
 * The aggs.cost a doc (board or ticket) should get from its legacy `cost`:
 * { set } when absent, { set, correction } when present and different (the
 * legacy counter wins; `correction` is for the report), {} when equal.
 */
export function planCostCounter(S, doc) {
  if (!doc?.cost) return {};
  const want = counterFromCost(S, doc.cost);
  const have = doc.aggs?.[S.COST_AGG_FIELD_ID];
  if (!have) return { set: want };
  if (sameCounter(have, want)) return {};
  return { set: want, correction: { have, want } };
}

/** The board's patch (update() keys), or null when nothing changes. */
export function planBoard(S, board) {
  const patch = {};
  const corrections = [];
  const fields = planAggFields(S, board.aggFields);
  if (fields) patch.aggFields = fields;
  const c = planCostCounter(S, board);
  if (c.set) patch[`aggs.${S.COST_AGG_FIELD_ID}`] = c.set;
  if (c.correction) corrections.push({ what: 'board.aggs.cost', ...c.correction });
  return { patch: Object.keys(patch).length ? patch : null, corrections };
}

/** The agg a receipt message should carry, or null when it needs none. */
export function aggForMessage(S, m) {
  if (!m || !m.run || m.agg) return null;
  const v = Number(m.run.costUsd);
  if (!Number.isFinite(v)) return null;
  return { entries: [{ fieldId: S.COST_AGG_FIELD_ID, value: S.roundAgg(v) }] };
}

/** Messages with `agg` added to every receipt that lacks it; `changed` counts them. */
export function rewriteMessages(S, messages) {
  let changed = 0;
  const out = (messages ?? []).map((m) => {
    const agg = aggForMessage(S, m);
    if (!agg) return m;
    changed++;
    return { ...m, agg };
  });
  return { messages: out, changed };
}

/** The ticket's patch (aggs.cost, recentMessages), or null. */
export function planTicket(S, ticket) {
  const patch = {};
  const corrections = [];
  const c = planCostCounter(S, ticket);
  if (c.set) patch[`aggs.${S.COST_AGG_FIELD_ID}`] = c.set;
  if (c.correction) corrections.push({ what: `ticket ${ticket.key}.aggs.cost`, ...c.correction });
  let messages = 0;
  if (Array.isArray(ticket.recentMessages)) {
    const r = rewriteMessages(S, ticket.recentMessages);
    if (r.changed) {
      patch.recentMessages = r.messages;
      messages = r.changed;
    }
  }
  return { patch: Object.keys(patch).length ? patch : null, corrections, messages };
}

/**
 * What to write for one legacy day doc into aggStats daily:{day}, given that
 * doc's current data (or undefined): { write: null } when its fields.cost
 * already equals the legacy day, else { write: { create | patch } } — `create`
 * for a missing doc, `patch` (update() keys; replaces fields.cost only) for an
 * existing one — and `correction` when a different fields.cost was there.
 */
export function planStatDay(S, stat, existing, now) {
  const have = existing?.fields?.[S.COST_AGG_FIELD_ID];
  const tickets = {};
  for (const [key, c] of Object.entries(stat.tickets ?? {})) tickets[key] = counterFromCost(S, c);
  const want = {
    total: S.roundAgg(Number(stat.costUsd ?? 0)),
    count: Number(stat.runs ?? 0),
    tickets,
  };
  const sameTickets =
    have &&
    Object.keys(have.tickets ?? {}).length === Object.keys(tickets).length &&
    Object.entries(tickets).every(([k, c]) => sameCounter(have.tickets?.[k], c));
  if (have && sameCounter(have, want) && sameTickets) return { write: null, correction: null };
  const correction = have ? { what: `aggStats daily:${stat.day}`, have, want } : null;
  const updatedAt = Math.max(Number(stat.updatedAt ?? 0), existing?.updatedAt ?? 0) || now;
  if (!existing)
    return {
      write: {
        create: {
          period: 'daily',
          key: stat.day,
          fields: { [S.COST_AGG_FIELD_ID]: want },
          updatedAt,
        },
      },
      correction,
    };
  return {
    write: {
      patch: {
        period: 'daily',
        key: stat.day,
        [`fields.${S.COST_AGG_FIELD_ID}`]: want,
        updatedAt,
      },
    },
    correction,
  };
}

/**
 * The migration. deps: { S, db } (firebase-admin or @google-cloud Firestore).
 * opts: { apply, log, now? }. Returns the summary.
 */
export async function migrateAggregates(deps, opts) {
  const { S, db } = deps;
  const { apply, log = () => {} } = opts;
  const now = opts.now ?? Date.now();
  const C = S.COLLECTIONS;
  const summary = {
    boards: 0,
    boardsToChange: 0,
    aggFieldsAdded: 0,
    boardCounters: 0,
    tickets: 0,
    ticketsToChange: 0,
    ticketCounters: 0,
    messages: 0,
    statDays: 0,
    aggStatsToWrite: 0,
    corrections: [],
    applied: { boards: 0, tickets: 0, aggStats: 0, failed: [] },
  };

  const boards = await db.collection(C.boards).get();
  for (const bs of boards.docs) {
    summary.boards++;
    const board = { id: bs.id, ...bs.data() };
    const label = board.key ?? board.id;

    // ── the board ──
    const bp = planBoard(S, board);
    for (const c of bp.corrections) summary.corrections.push({ board: label, ...c });
    if (bp.patch) {
      summary.boardsToChange++;
      if (bp.patch.aggFields) summary.aggFieldsAdded++;
      if (bp.patch[`aggs.${S.COST_AGG_FIELD_ID}`]) summary.boardCounters++;
      log(`${label}: ${Object.keys(bp.patch).join(', ')}`);
      if (apply) {
        try {
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(bs.ref);
            const fresh = planBoard(S, { id: bs.id, ...snap.data() });
            if (fresh.patch) tx.update(bs.ref, fresh.patch);
          });
          summary.applied.boards++;
        } catch (e) {
          summary.applied.failed.push({ at: `board ${label}`, error: String(e?.message ?? e) });
        }
      }
    }

    // ── its tickets (and their data pages) ──
    const tickets = await bs.ref.collection(C.tickets).get();
    for (const ts of tickets.docs) {
      summary.tickets++;
      const ticket = { id: ts.id, ...ts.data() };
      // A receipt always bumped ticket.cost: a ticket without it has none to tag.
      const hasReceipts = (ticket.cost?.runs ?? 0) > 0;
      const tp = planTicket(S, ticket);
      for (const c of tp.corrections) summary.corrections.push({ board: label, ...c });
      let pageMessages = 0;
      if (hasReceipts)
        for (let n = 0; n < (ticket.pageCount ?? 0); n++) {
          const ps = await ts.ref.collection(C.data).doc(S.pageId(n)).get();
          if (ps.exists) pageMessages += rewriteMessages(S, ps.get('messages')).changed;
        }
      if (!tp.patch && !pageMessages) continue;
      summary.ticketsToChange++;
      if (tp.patch?.[`aggs.${S.COST_AGG_FIELD_ID}`]) summary.ticketCounters++;
      summary.messages += tp.messages + pageMessages;
      if (!apply) continue;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ts.ref);
          if (!snap.exists) return;
          const t = { id: ts.id, ...snap.data() };
          const pageRefs = [];
          if ((t.cost?.runs ?? 0) > 0)
            for (let n = 0; n < (t.pageCount ?? 0); n++)
              pageRefs.push(ts.ref.collection(C.data).doc(S.pageId(n)));
          const pageSnaps = await Promise.all(pageRefs.map((r) => tx.get(r)));
          const fresh = planTicket(S, t);
          if (fresh.patch) tx.update(ts.ref, fresh.patch);
          pageSnaps.forEach((p, i) => {
            if (!p.exists) return;
            const r = rewriteMessages(S, p.get('messages'));
            if (r.changed) tx.update(pageRefs[i], { messages: r.messages });
          });
        });
        summary.applied.tickets++;
      } catch (e) {
        summary.applied.failed.push({
          at: `ticket ${ticket.key ?? ts.id}`,
          error: String(e?.message ?? e),
        });
      }
    }

    // ── its day stats → aggStats daily:{day} ──
    const stats = await bs.ref.collection(C.stats).get();
    for (const ss of stats.docs) {
      summary.statDays++;
      const stat = { ...ss.data(), day: ss.id };
      const ref = bs.ref.collection(C.aggStats).doc(S.aggStatsId('daily', stat.day));
      const ex = await ref.get();
      const plan = planStatDay(S, stat, ex.exists ? ex.data() : undefined, now);
      if (plan.correction) summary.corrections.push({ board: label, ...plan.correction });
      if (!plan.write) continue;
      summary.aggStatsToWrite++;
      if (!apply) continue;
      try {
        await db.runTransaction(async (tx) => {
          const cur = await tx.get(ref);
          const p = planStatDay(S, stat, cur.exists ? cur.data() : undefined, now);
          if (p.write?.create) tx.create(ref, p.write.create);
          else if (p.write?.patch) tx.update(ref, p.write.patch);
        });
        summary.applied.aggStats++;
      } catch (e) {
        summary.applied.failed.push({
          at: `aggStats ${label} daily:${stat.day}`,
          error: String(e?.message ?? e),
        });
      }
    }
  }

  log('');
  log(
    `boards ${summary.boards} (${summary.boardsToChange} to change: ${summary.aggFieldsAdded} get the Cost field, ` +
      `${summary.boardCounters} get aggs.cost)`,
  );
  log(
    `tickets ${summary.tickets} (${summary.ticketsToChange} to change: ${summary.ticketCounters} get aggs.cost, ` +
      `${summary.messages} receipt messages get agg)`,
  );
  log(`day stats ${summary.statDays} (${summary.aggStatsToWrite} aggStats daily docs to write)`);
  if (summary.corrections.length) {
    log(`corrected from the legacy counters (aggs differed) ${summary.corrections.length}:`);
    for (const c of summary.corrections.slice(0, 20))
      log(`  ${c.board} ${c.what}: have ${JSON.stringify(c.have)} want ${JSON.stringify(c.want)}`);
  }
  if (apply)
    log(
      `applied: boards ${summary.applied.boards}, tickets ${summary.applied.tickets}, aggStats ${summary.applied.aggStats}` +
        (summary.applied.failed.length ? `, FAILED ${summary.applied.failed.length}` : ''),
    );
  for (const f of summary.applied.failed) log(`  failed ${f.at}: ${f.error}`);
  return summary;
}
