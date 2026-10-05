/**
 * indicators.html §Migration — every entity gets an `indicator`, every board
 * a plain-text description.
 *
 *   boards/{b}                  indicator ||= indicatorOf(board, b) (legacy color + typed icon);
 *                               color kept (a board with no usable colour gets
 *                               indicatorColor(indicator)); description: rich
 *                               text → plain text (descriptionText)
 *   boards/{b}.stages[]         indicator ||= indicatorOf(stage, stage.id); description stays absent
 *   artifacts/{a}               indicator ||= emoji icon, else defaultIndicator(a)
 *                               (the old '◆' glyph is not an emoji)
 *   memories/{m}                indicator ||= emoji icon, else 🧠 (the old default)
 *   users/{u}/workspaces/{w}    indicator ||= indicatorOf(workspace, w) (its colour)
 *
 * Nothing legacy is deleted (color / icon stay; indicatorOf prefers
 * `indicator` once it is there). IDEMPOTENT: a doc that already has its
 * indicator (and a string description) plans nothing, so a re-run writes nothing.
 *
 * Pure planning functions first (unit-tested in qaqc/test/migrate-indicators.test.ts);
 * migrateIndicators() is the I/O (emulator-tested in qaqc/rules/migrate-indicators.test.ts).
 * `S` is @tm/shared, passed in so this file runs under plain node and under vitest.
 */


/** The stages with an indicator each, or null when every stage has one. */
export function planStages(S, stages) {
  if (!Array.isArray(stages) || stages.every((s) => s?.indicator)) return null;
  return stages.map((s) => (s?.indicator ? s : { ...s, indicator: S.indicatorOf(s, s.id ?? '') }));
}

/** The board's patch (update() keys), or null when nothing changes. */
export function planBoard(S, board) {
  const patch = {};
  if (!board.indicator) {
    const indicator = S.indicatorOf(board, board.id ?? '');
    patch.indicator = indicator;
    if (!S.legacyColor(board.color)) patch.color = S.indicatorColor(indicator);
  }
  const d = board.description;
  if (d !== null && d !== undefined && typeof d !== 'string')
    patch.description = S.descriptionText(d);
  const stages = planStages(S, board.stages);
  if (stages) patch.stages = stages;
  return Object.keys(patch).length ? patch : null;
}

const emojiIcon = (S, icon) => {
  if (typeof icon !== 'string' || !icon) return null;
  const r = S.IndicatorSchema.safeParse({ kind: 'emoji', emoji: icon });
  return r.success ? r.data : null;
};

export function planArtifact(S, a) {
  if (a.indicator) return null;
  return { indicator: emojiIcon(S, a.icon) ?? S.defaultIndicator(a.id ?? '') };
}

export function planMemory(S, m) {
  if (m.indicator) return null;
  return { indicator: emojiIcon(S, m.icon) ?? { ...S.MEMORY_DEFAULT_INDICATOR } };
}

export function planWorkspace(S, w) {
  if (w.indicator) return null;
  return { indicator: S.indicatorOf(w, w.id ?? '') };
}

const KINDS = ['boards', 'artifacts', 'memories', 'workspaces'];

/**
 * Walk every board, artifact, memory and workspace; plan, and with
 * `apply` write each patch in a transaction that re-plans from the fresh doc.
 */
export async function migrateIndicators(deps, opts) {
  const { S, db } = deps;
  const { apply, log = () => {} } = opts;
  const C = S.COLLECTIONS;
  const summary = { applied: { failed: [] } };
  for (const k of KINDS) {
    summary[k] = { seen: 0, toChange: 0 };
    summary.applied[k] = 0;
  }
  let descriptions = 0;
  let stages = 0;

  async function each(kind, snaps, plan, label) {
    for (const snap of snaps) {
      summary[kind].seen++;
      const patch = plan(S, { id: snap.id, ...snap.data() });
      if (!patch) continue;
      summary[kind].toChange++;
      if ('description' in patch) descriptions++;
      if (patch.stages)
        stages += patch.stages.filter(
          (s, i) => s.indicator && !snap.data().stages?.[i]?.indicator,
        ).length;
      log(`${kind} ${label(snap)}: ${Object.keys(patch).join(', ')}`);
      if (!apply) continue;
      try {
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(snap.ref);
          if (!fresh.exists) return;
          const p = plan(S, { id: fresh.id, ...fresh.data() });
          if (p) tx.update(snap.ref, p);
        });
        summary.applied[kind]++;
      } catch (e) {
        summary.applied.failed.push({
          at: `${kind} ${snap.ref.path}`,
          error: String(e?.message ?? e),
        });
      }
    }
  }

  const boards = await db.collection(C.boards).get();
  await each('boards', boards.docs, planBoard, (s) => s.get('key') ?? s.id);
  const artifacts = await db.collection(C.artifacts).get();
  await each('artifacts', artifacts.docs, planArtifact, (s) => s.id);
  const memories = await db.collection(C.memories).get();
  await each('memories', memories.docs, planMemory, (s) => s.id);
  // users/{uid}/workspaces/{id} — only that collection of that name.
  const ws = await db.collectionGroup(C.workspaces).get();
  await each(
    'workspaces',
    ws.docs.filter((d) => d.ref.parent.parent?.parent?.id === C.users),
    planWorkspace,
    (s) => s.ref.path,
  );

  summary.descriptions = descriptions;
  summary.stages = stages;
  log(
    KINDS.map((k) => `${k} ${summary[k].toChange}/${summary[k].seen}`).join(' · ') +
      ` · board descriptions flattened ${descriptions} · stages ${stages}`,
  );
  return summary;
}
