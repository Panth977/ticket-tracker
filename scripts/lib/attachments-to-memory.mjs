/**
 * TICKET ATTACHMENTS → ONE MEMORY (docs/plan/memory.html §E, §J) — the core of
 * scripts/migrate-attachments-to-memory.mjs, importable so it can be tested.
 *
 * Every dependency comes in as an argument (`S` = @tm/shared, `db` = an Admin
 * Firestore, `bucket` = an Admin Storage bucket, `FieldValue`), so this file
 * resolves nothing itself: the CLI hands it the BUILT backend's copies, the
 * tests hand it the source and the emulators.
 *
 * WHAT MOVES. Each LIVE `ticket.files[]` row whose `path` is a board
 * attachment (boards/{b}/tickets/{t}/{id}/{name}) becomes a file node in the
 * memory at
 *
 *     boards/<BOARDKEY>/<TICKETKEY>/<time>_<filename>
 *
 * (fillAttachTemplate of the board's new default template, with <time> =
 * attachTime(row.createdAt)), a taken path numbered ' (2)', ' (3)'…. The bytes
 * are COPIED to memories/{m}/{fileId}/{name}; the old object is never deleted
 * here. Then the row — and every message attachment, inline or in a data
 * page, with the same old path — becomes a memory reference:
 * path = memoryRefPath(m, node), memory = { memoryId, nodeId }, no thumbPath.
 *
 * LEFT ALONE: rows already pointing at a memory, tombstoned rows (deletedAt
 * set), rows whose path is not a board attachment, rows whose object is gone
 * (reported).
 *
 * IDEMPOTENT. A node's id and its object's file id are DERIVED from the old
 * object path (nodeIdFor / fileIdFor), so a re-run finds what an interrupted
 * run made: the copy is skipped when the object exists, the node is reused
 * when it exists (wherever it was moved since), and a row that already points
 * at a memory is skipped. Each ticket's nodes, the memory's counters, the
 * ticket document and its data pages are ONE transaction.
 */
import { createHash, randomInt } from 'node:crypto';

export const MIGRATION_STAMP = 'attachmentsToMemory';
export const DEFAULT_MEMORY_NAME = 'ticket';
export const DEFAULT_MEMORY_DESCRIPTION = 'Ticket attachments, moved from boards';
/** Firestore allows 500 writes in a transaction; keep room for the ticket, pages and memory. */
export const MAX_WRITES_PER_TICKET = 450;

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Same shape as the backend's ids: 20 alphanumerics. */
export function randomId(n = 20) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}

const digest = (s) => createHash('sha256').update(s).digest('base64url').slice(0, 24);
/** The file node an old object becomes. Deterministic: a re-run finds it. */
export const nodeIdFor = (oldPath) => `mig${digest(`node:${oldPath}`)}`;
/** The Storage file id of its copy. Deterministic: a re-run skips the copy. */
export const fileIdFor = (oldPath) => `mig${digest(`file:${oldPath}`)}`;

/** The default template every board gets. */
export const boardTemplate = (boardKey) => `boards/${boardKey}/<ticketId>/<time>_<filename>`;

/** 'memory' | 'deleted' | 'foreign' | 'move' — what the migration does with one files[] row. */
export function classifyRow(S, row) {
  if (row.memory || String(row.path ?? '').startsWith('memories/')) return 'memory';
  if (row.deletedAt != null) return 'deleted';
  if (!S.parseAttachmentPath(String(row.path ?? ''))) return 'foreign';
  return 'move';
}

/** Where a row goes in the memory, before numbering; null when no valid path can be made. */
export function targetPathFor(S, boardKey, ticketKey, row) {
  const filled = S.fillAttachTemplate(boardTemplate(boardKey), {
    ticketKey,
    at: row.createdAt,
    random6: '',
    filename: row.name,
  });
  return filled ? filled.path : null;
}

/** 'a/b/c.png' → ['a', 'a/b']. */
export function parentPaths(path) {
  const segs = path.split('/');
  return segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('/'));
}

/**
 * The first free path: `wanted`, else numberedPath(wanted, 2, 3, …).
 * `taken` maps path → 'file' | 'folder' (existing nodes and earlier plans).
 * Returns { path, n } (n = 1 when not renamed) or { error } when a FILE sits
 * where a parent folder must be.
 */
export function allocatePath(S, wanted, taken) {
  for (const p of parentPaths(wanted))
    if (taken.get(p) === 'file') return { error: `${p} is a file, not a folder` };
  if (!taken.has(wanted)) return { path: wanted, n: 1 };
  for (let n = 2; n < 100_000; n++) {
    const p = S.numberedPath(wanted, n);
    if (!taken.has(p)) return { path: p, n };
  }
  return { error: `no free name for ${wanted}` };
}

/** Mark a planned file (and its parents) as taken. */
export function take(taken, path) {
  for (const p of parentPaths(path)) if (!taken.has(p)) taken.set(p, 'folder');
  taken.set(path, 'file');
}

/**
 * Plan one ticket. Pure, apart from mutating `state`:
 *   state.taken      Map<path, 'file'|'folder'>  every node path in the memory + planned
 *   state.nodesById  Map<nodeId, { path }>       existing nodes (to reuse a node a previous run made)
 *   state.objects    Map<oldPath, { exists, size?, contentType? }>  Storage facts (from the caller)
 *
 * Returns { moves, skipped } — one move per distinct OLD PATH among the live
 * board-attachment rows (two rows sharing a path share a node).
 */
export function planTicket(S, state, board, ticket) {
  const moves = [];
  const skipped = [];
  const byPath = new Map();
  const files = [...(ticket.files ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  for (const row of files) {
    const kind = classifyRow(S, row);
    if (kind === 'memory' || kind === 'deleted') continue;
    if (kind === 'foreign') {
      skipped.push({ rowId: row.id, path: row.path, reason: 'not a board attachment path' });
      continue;
    }
    const seen = byPath.get(row.path);
    if (seen) {
      seen.rowIds.push(row.id);
      continue;
    }
    const nodeId = nodeIdFor(row.path);
    const fileId = fileIdFor(row.path);
    const existing = state.nodesById.get(nodeId);
    if (existing) {
      // An earlier (interrupted) run made it: reuse, wherever it is now.
      const m = {
        ...baseMove(row, nodeId, fileId),
        path: existing.path,
        reused: true,
        renamed: false,
      };
      byPath.set(row.path, m);
      moves.push(m);
      continue;
    }
    const obj = state.objects.get(row.path);
    if (!obj || !obj.exists) {
      skipped.push({ rowId: row.id, path: row.path, reason: 'Storage object missing' });
      continue;
    }
    const wanted = targetPathFor(S, board.key, ticket.key, row);
    if (!wanted) {
      skipped.push({ rowId: row.id, path: row.path, reason: 'no valid memory path for this name' });
      continue;
    }
    const got = allocatePath(S, wanted, state.taken);
    if (got.error) {
      skipped.push({ rowId: row.id, path: row.path, reason: got.error });
      continue;
    }
    take(state.taken, got.path);
    const m = {
      ...baseMove(row, nodeId, fileId),
      path: got.path,
      reused: false,
      renamed: got.n > 1,
      size: Number.isFinite(obj.size) ? obj.size : row.size,
      mime: row.mime || obj.contentType || 'application/octet-stream',
    };
    byPath.set(row.path, m);
    moves.push(m);
  }
  return { moves, skipped };
}

function baseMove(row, nodeId, fileId) {
  return {
    oldPath: row.path,
    rowIds: [row.id],
    nodeId,
    fileId,
    name: row.name,
    mime: row.mime || 'application/octet-stream',
    size: row.size,
    width: Number.isInteger(row.width) && row.width > 0 ? row.width : undefined,
    height: Number.isInteger(row.height) && row.height > 0 ? row.height : undefined,
    createdAt: row.createdAt,
    uploadedBy: row.uploadedBy,
  };
}

/** Folders a set of planned paths needs that are not in `existing` (Map path → kind), root first. */
export function foldersToCreate(paths, existing) {
  const out = new Set();
  for (const p of paths) for (const f of parentPaths(p)) if (!existing.has(f)) out.add(f);
  return [...out].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
}

/** The memory object a move's bytes are copied to (the backend's own naming: storageNameOf). */
export const storagePathFor = (S, memoryId, move) =>
  S.memoryStoragePath(memoryId, move.fileId, encodeURIComponent(S.memoryBaseName(move.path)));

/** The MemoryNode a move creates. */
export function fileNodeFor(S, memoryId, move, parentId) {
  const file = {
    fileId: move.fileId,
    storagePath: storagePathFor(S, memoryId, move),
    mime: move.mime,
    size: move.size,
  };
  if (move.width && move.height) Object.assign(file, { width: move.width, height: move.height });
  return {
    kind: 'file',
    parentId,
    name: S.memoryBaseName(move.path),
    path: move.path,
    file,
    createdAt: move.createdAt,
    createdBy: move.uploadedBy,
    updatedAt: move.createdAt,
    updatedBy: move.uploadedBy,
  };
}

export const folderNodeFor = (S, parentId, path, by, now) => ({
  kind: 'folder',
  parentId,
  name: S.memoryBaseName(path),
  path,
  file: null,
  createdAt: now,
  createdBy: by,
  updatedAt: now,
  updatedBy: by,
});

/**
 * One attachment (a files[] row or a message's) → its memory reference, when
 * its old path was moved. Everything else about it is kept; thumbPath goes
 * (it named an object under the board — a memory reference has none).
 */
export function rewriteAttachment(S, a, refs, memoryId) {
  if (!a || a.memory) return a;
  const nodeId = refs.get(a.path);
  if (!nodeId) return a;
  const { thumbPath: _t, ...rest } = a;
  return { ...rest, path: S.memoryRefPath(memoryId, nodeId), memory: { memoryId, nodeId } };
}

/**
 * The ticket's `files` and `recentMessages` with references rewritten.
 * Tombstoned file rows are left as they are. { files, recentMessages, changed }.
 */
export function rewriteTicket(S, ticket, refs, memoryId) {
  let changed = 0;
  const files = (ticket.files ?? []).map((f) => {
    if (f.deletedAt != null) return f;
    const n = rewriteAttachment(S, f, refs, memoryId);
    if (n !== f) changed++;
    return n;
  });
  const msgs = rewriteMessages(S, ticket.recentMessages ?? [], refs, memoryId);
  return { files, recentMessages: msgs.messages, changed: changed + msgs.changed };
}

/** Messages (inline or a data page's) with their attachments rewritten. */
export function rewriteMessages(S, messages, refs, memoryId) {
  let changed = 0;
  const out = messages.map((m) => {
    if (!Array.isArray(m.attachments) || m.attachments.length === 0) return m;
    let hit = false;
    const attachments = m.attachments.map((a) => {
      const n = rewriteAttachment(S, a, refs, memoryId);
      if (n !== a) {
        hit = true;
        changed++;
      }
      return n;
    });
    return hit ? { ...m, attachments } : m;
  });
  return { messages: out, changed };
}

/** Message attachments with a board path that no live files[] row explains (reported, left alone). */
export function orphanMessageAttachments(S, ticket, pages) {
  const known = new Set((ticket.files ?? []).map((f) => f.path));
  const out = [];
  const all = [...(ticket.recentMessages ?? []), ...pages.flatMap((p) => p.messages ?? [])];
  for (const m of all)
    for (const a of m.attachments ?? [])
      if (!a.memory && S.parseAttachmentPath(String(a.path ?? '')) && !known.has(a.path))
        out.push({ messageId: m.id, path: a.path });
  return out;
}

const fmtBytes = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`;

// ─── the run ────────────────────────────────────────────────────────────────

/**
 * Plan (and with apply: perform) the migration.
 *
 * deps: { S, db, bucket, FieldValue }
 * opts: { ownerUid, memoryName?, apply?, log?, now?, sample? }
 *
 * Returns the summary (also what the tests assert on). Throws — before any
 * write — when the grants or the node count would pass a limit.
 */
export async function migrateAttachmentsToMemory(deps, opts) {
  const { S, db, bucket } = deps;
  const {
    ownerUid,
    memoryName = DEFAULT_MEMORY_NAME,
    apply = false,
    log = (m) => console.log(m),
    now = Date.now(),
    sample = 20,
  } = opts;
  if (!ownerUid) throw new Error('ownerUid is required');
  const C = S.COLLECTIONS;

  // ── 1. the memory ──
  const owned = await db.collection(C.memories).where('ownerUid', '==', ownerUid).get();
  const matches = owned.docs
    .filter((d) => d.get('name') === memoryName && !d.get('deletingAt'))
    .sort((a, b) => a.get('createdAt') - b.get('createdAt'));
  if (matches.length > 1)
    log(`! ${matches.length} memories named "${memoryName}" — using the oldest, ${matches[0].id}`);
  let memoryId = matches[0]?.id ?? null;
  let memory = matches[0]?.data() ?? null;
  if (memory && memory.archivedAt != null)
    throw new Error(`memory ${memoryId} ("${memoryName}") is archived — restore it first`);
  if (!memory && owned.size >= S.MEMORIES_OWNED_MAX)
    throw new Error(`the owner already owns ${owned.size} memories (max ${S.MEMORIES_OWNED_MAX})`);
  log(
    memory
      ? `memory: ${memoryId} ("${memoryName}", ${memory.stats.files} file(s), ${memory.stats.folders} folder(s))`
      : `memory: none named "${memoryName}" — ${apply ? 'will create it' : 'would create it'}`,
  );

  // ── 2. boards and grants ──
  const boardSnap = await db.collection(C.boards).get();
  const boards = boardSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const grantIds = new Set([...Object.keys(memory?.boards ?? {}), ...boards.map((b) => b.id)]);
  const summary = {
    memoryId,
    memoryCreated: false,
    boards: boards.length,
    archivedBoards: boards.filter((b) => b.archivedAt != null).length,
    grants: grantIds.size,
    grantsMax: S.MEMORY_GRANTS_MAX,
    grantsToWrite: 0,
    attachMemoryToWrite: 0,
    attachMemoryReplaced: [],
    tickets: 0,
    ticketsToChange: 0,
    filesToMove: 0,
    filesReused: 0,
    bytes: 0,
    renamed: 0,
    foldersToCreate: 0,
    refsToRewrite: 0,
    skipped: [],
    orphans: [],
    nodesExisting: 0,
    nodesMax: S.MEMORY_NODES_MAX,
    applied: { tickets: 0, files: 0, folders: 0, copied: 0, refs: 0, failed: [] },
  };
  log(
    `boards: ${boards.length} (${summary.archivedBoards} archived); grants after: ${grantIds.size} / max ${S.MEMORY_GRANTS_MAX}`,
  );
  if (grantIds.size > S.MEMORY_GRANTS_MAX) {
    summary.stopped = `there are ${grantIds.size} boards to grant but a memory may be granted to at most ${S.MEMORY_GRANTS_MAX}`;
    log(`STOP: ${summary.stopped}. Nothing was written.`);
    return summary;
  }

  // ── 3. what the memory already holds ──
  const state = { taken: new Map(), nodesById: new Map(), objects: new Map() };
  if (memoryId) {
    const nodes = await db.collection(`${C.memories}/${memoryId}/${C.nodes}`).get();
    for (const d of nodes.docs) {
      state.taken.set(d.get('path'), d.get('kind'));
      state.nodesById.set(d.id, { path: d.get('path') });
    }
    summary.nodesExisting = nodes.size;
  }

  // ── 4. plan every ticket of every board ──
  const plans = [];
  for (const board of boards) {
    const want = { memoryId: memoryId ?? '(new)', template: boardTemplate(board.key) };
    const problem = S.attachTemplateProblem(want.template);
    if (problem) throw new Error(`board ${board.key}: template ${want.template} — ${problem}`);
    if (memory?.boards?.[board.id] !== 'write') summary.grantsToWrite++;
    const cur = board.attachMemory;
    if (!cur || cur.memoryId !== memoryId || cur.template !== want.template) {
      summary.attachMemoryToWrite++;
      if (cur && cur.memoryId !== memoryId)
        summary.attachMemoryReplaced.push({ board: board.key, was: cur });
    }
    const tickets = await db.collection(`${C.boards}/${board.id}/${C.tickets}`).get();
    for (const t of tickets.docs.sort((a, b) => a.get('createdAt') - b.get('createdAt'))) {
      summary.tickets++;
      const ticket = { id: t.id, ...t.data() };
      // Storage facts for the rows that may move (and are not a node yet).
      const candidates = [
        ...new Set(
          (ticket.files ?? [])
            .filter((r) => classifyRow(S, r) === 'move' && !state.nodesById.has(nodeIdFor(r.path)))
            .map((r) => r.path),
        ),
      ];
      await Promise.all(
        candidates.map(async (p) => {
          if (state.objects.has(p)) return;
          const f = bucket.file(p);
          const [exists] = await f.exists();
          if (!exists) return state.objects.set(p, { exists: false });
          const [md] = await f.getMetadata();
          state.objects.set(p, {
            exists: true,
            size: Number(md.size),
            contentType: md.contentType,
          });
        }),
      );
      const pages = [];
      for (let n = 0; n < (ticket.pageCount ?? 0); n++) {
        const ps = await t.ref.collection(C.data).doc(S.pageId(n)).get();
        if (ps.exists) pages.push({ id: ps.id, ...ps.data() });
      }
      const plan = planTicket(S, state, board, ticket);
      for (const s of plan.skipped) summary.skipped.push({ ticket: ticket.key, ...s });
      for (const o of orphanMessageAttachments(S, ticket, pages))
        summary.orphans.push({ ticket: ticket.key, ...o });
      if (!plan.moves.length) continue;
      const refs = new Map(plan.moves.map((m) => [m.oldPath, m.nodeId]));
      const mid = memoryId ?? 'NEWMEMORY0';
      let refCount = rewriteTicket(S, ticket, refs, mid).changed;
      for (const p of pages) refCount += rewriteMessages(S, p.messages ?? [], refs, mid).changed;
      summary.refsToRewrite += refCount;
      summary.ticketsToChange++;
      for (const m of plan.moves) {
        if (m.reused) summary.filesReused++;
        else {
          summary.filesToMove++;
          summary.bytes += m.size;
          if (m.renamed) summary.renamed++;
        }
      }
      plans.push({ board, ticketId: t.id, ticketKey: ticket.key, moves: plan.moves });
    }
  }
  // Folders the new files need, against what exists (taken holds planned folders too, so recompute).
  const existingPaths = new Map();
  if (memoryId) for (const [, n] of state.nodesById) existingPaths.set(n.path, 'x');
  const newFolders = foldersToCreate(
    plans.flatMap((p) => p.moves.filter((m) => !m.reused).map((m) => m.path)),
    existingPaths,
  );
  summary.foldersToCreate = newFolders.length;

  // ── 5. limits, then the report ──
  const nodesAfter = summary.nodesExisting + summary.filesToMove + summary.foldersToCreate;
  log('');
  log(`tickets scanned:            ${summary.tickets}`);
  log(`tickets to change:          ${summary.ticketsToChange}`);
  log(
    `files to move:              ${summary.filesToMove} (${fmtBytes(summary.bytes)})${summary.filesReused ? ` + ${summary.filesReused} already a node (refs only)` : ''}`,
  );
  log(`renamed on a clash:         ${summary.renamed}`);
  log(`folders to create:          ${summary.foldersToCreate}`);
  log(`references to rewrite:      ${summary.refsToRewrite} (file rows + message attachments)`);
  log(
    `grants to write:            ${summary.grantsToWrite}; boards.attachMemory to set: ${summary.attachMemoryToWrite}`,
  );
  log(`memory nodes after:         ${nodesAfter} / max ${S.MEMORY_NODES_MAX}`);
  for (const r of summary.attachMemoryReplaced)
    log(`! board ${r.board}: replaces attachMemory ${JSON.stringify(r.was)}`);
  const missing = summary.skipped.filter((s) => s.reason === 'Storage object missing');
  log(
    `skipped:                    ${summary.skipped.length} (${missing.length} with the Storage object missing)`,
  );
  for (const s of summary.skipped.slice(0, 50))
    log(`  skip ${s.ticket} row ${s.rowId}: ${s.reason} — ${s.path}`);
  if (summary.orphans.length) {
    log(`message attachments with no live file row (left alone): ${summary.orphans.length}`);
    for (const o of summary.orphans.slice(0, 20))
      log(`  ${o.ticket} message ${o.messageId}: ${o.path}`);
  }
  const moves = plans.flatMap((p) => p.moves.map((m) => ({ ...m, ticketKey: p.ticketKey })));
  if (moves.length) {
    log(`sample (${Math.min(sample, moves.length)} of ${moves.length}):`);
    for (const m of moves.slice(0, sample))
      log(
        `  ${m.ticketKey}  ${m.oldPath}  →  ${memoryName}:/${m.path}${m.renamed ? '  (renamed)' : ''}${m.reused ? '  (node exists)' : ''}  ${fmtBytes(m.size)}`,
      );
  }
  if (nodesAfter > S.MEMORY_NODES_MAX) {
    summary.stopped = `the memory would hold ${nodesAfter} nodes; at most ${S.MEMORY_NODES_MAX}`;
    log(`STOP: ${summary.stopped}. Nothing was written.`);
    return summary;
  }
  if (!apply) return summary;
  if (!plans.length && !summary.grantsToWrite && !summary.attachMemoryToWrite) {
    log('nothing to do — already migrated');
    return summary;
  }

  // ── 6. apply: the memory, the grants, the boards' default ──
  log('');
  if (!memoryId) {
    memoryId = randomId();
    memory = {
      name: memoryName,
      description: DEFAULT_MEMORY_DESCRIPTION,
      icon: null,
      ownerUid,
      access: { [ownerUid]: 'owner' },
      memberUids: [ownerUid],
      boards: {},
      artifacts: {},
      boardIds: [],
      stats: { files: 0, folders: 0, bytes: 0 },
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.doc(`${C.memories}/${memoryId}`).create(memory);
    summary.memoryCreated = true;
    log(`created memory ${memoryId} ("${memoryName}")`);
  }
  summary.memoryId = memoryId;
  const memRef = db.doc(`${C.memories}/${memoryId}`);
  {
    const grantsBatch = db.batch();
    const grants = { ...(memory.boards ?? {}) };
    for (const b of boards) grants[b.id] = 'write';
    grantsBatch.update(memRef, {
      boards: grants,
      boardIds: Object.keys(grants).sort(),
      updatedAt: now,
    });
    for (const b of boards)
      grantsBatch.update(db.doc(`${C.boards}/${b.id}`), {
        attachMemory: { memoryId, template: boardTemplate(b.key) },
      });
    await grantsBatch.commit();
    log(`granted 'write' to ${boards.length} board(s) and set their attachMemory`);
  }

  // ── 7. apply: ticket by ticket ──
  const nodesCol = memRef.collection(C.nodes);
  let done = 0;
  for (const p of plans) {
    try {
      const res = await applyTicket(deps, { memoryId, memRef, nodesCol, ownerUid, now }, p);
      summary.applied.tickets++;
      summary.applied.files += res.files;
      summary.applied.folders += res.folders;
      summary.applied.copied += res.copied;
      summary.applied.refs += res.refs;
    } catch (e) {
      summary.applied.failed.push({ ticket: p.ticketKey, error: String(e?.message ?? e) });
      log(`! ${p.ticketKey}: ${e?.message ?? e} — re-run to retry`);
    }
    done++;
    if (done % 10 === 0 || done === plans.length)
      log(`progress: ${done}/${plans.length} ticket(s)`);
  }
  log(
    `applied: ${summary.applied.tickets} ticket(s), ${summary.applied.files} file node(s), ` +
      `${summary.applied.folders} folder(s), ${summary.applied.copied} object(s) copied, ` +
      `${summary.applied.refs} reference(s) rewritten, ${summary.applied.failed.length} failed`,
  );
  return summary;
}

/** Copy the bytes (idempotent), then ONE transaction for nodes + counters + ticket + pages. */
async function applyTicket(deps, ctx, plan) {
  const { S, db, bucket, FieldValue } = deps;
  const { memoryId, memRef, nodesCol, ownerUid, now } = ctx;
  const C = S.COLLECTIONS;
  let copied = 0;
  for (const m of plan.moves) {
    if (m.reused) continue;
    const dest = bucket.file(storagePathFor(S, memoryId, m));
    const [there] = await dest.exists();
    if (there) continue;
    await bucket.file(m.oldPath).copy(dest);
    // The copy carries the old object's metadata; a Firebase download token
    // is not wanted on it (files are served through the file door only).
    await dest
      .setMetadata({ metadata: { firebaseStorageDownloadTokens: null, migratedFrom: m.oldPath } })
      .catch(() => {});
    copied++;
  }
  const ticketRef = db.doc(`${C.boards}/${plan.board.id}/${C.tickets}/${plan.ticketId}`);
  const refs = new Map(plan.moves.map((m) => [m.oldPath, m.nodeId]));
  if (plan.moves.length > MAX_WRITES_PER_TICKET)
    throw new Error(`${plan.moves.length} files on one ticket — more than one transaction holds`);

  return db.runTransaction(async (tx) => {
    // ── reads ──
    const memSnap = await tx.get(memRef);
    const tSnap = await tx.get(ticketRef);
    if (!memSnap.exists) throw new Error('memory vanished');
    if (!tSnap.exists) throw new Error('ticket vanished');
    const ticket = tSnap.data();
    const pageRefs = [];
    for (let n = 0; n < (ticket.pageCount ?? 0); n++)
      pageRefs.push(ticketRef.collection(C.data).doc(S.pageId(n)));
    const pageSnaps = await Promise.all(pageRefs.map((r) => tx.get(r)));
    const nodeSnaps = await Promise.all(plan.moves.map((m) => tx.get(nodesCol.doc(m.nodeId))));
    const toCreate = plan.moves.filter((_, i) => !nodeSnaps[i].exists);
    const atPath = await Promise.all(
      toCreate.map((m) => tx.get(nodesCol.where('path', '==', m.path).limit(1))),
    );
    atPath.forEach((q, i) => {
      if (!q.empty)
        throw new Error(`${toCreate[i].path} was taken in the memory since the plan was made`);
    });
    const folderPaths = foldersToCreate(
      toCreate.map((m) => m.path),
      new Map(),
    );
    const folderSnaps = await Promise.all(
      folderPaths.map((p) => tx.get(nodesCol.where('path', '==', p).limit(1))),
    );

    // ── plan the writes ──
    const folderId = new Map();
    const newFolders = [];
    folderPaths.forEach((p, i) => {
      const d = folderSnaps[i].docs[0];
      if (d) {
        if (d.get('kind') !== 'folder') throw new Error(`${p} is a file, not a folder`);
        folderId.set(p, d.id);
        return;
      }
      const parent = p.includes('/') ? (folderId.get(S.memoryParentPath(p)) ?? null) : null;
      const id = randomId();
      folderId.set(p, id);
      newFolders.push({ id, node: folderNodeFor(S, parent, p, ownerUid, now) });
    });
    const stats = memSnap.get('stats') ?? { files: 0, folders: 0 };
    const adding = newFolders.length + toCreate.length;
    if (stats.files + stats.folders + adding > S.MEMORY_NODES_MAX)
      throw new Error(`the memory would pass ${S.MEMORY_NODES_MAX} nodes`);

    const rt = rewriteTicket(S, ticket, refs, memoryId);
    const pageWrites = [];
    let refCount = rt.changed;
    pageSnaps.forEach((ps, i) => {
      if (!ps.exists) return;
      const r = rewriteMessages(S, ps.get('messages') ?? [], refs, memoryId);
      if (r.changed) {
        refCount += r.changed;
        pageWrites.push({ ref: pageRefs[i], messages: r.messages });
      }
    });

    // ── writes ──
    for (const f of newFolders) tx.create(nodesCol.doc(f.id), f.node);
    let bytes = 0;
    for (const m of toCreate) {
      const parent = folderId.get(S.memoryParentPath(m.path)) ?? null;
      tx.create(nodesCol.doc(m.nodeId), fileNodeFor(S, memoryId, m, parent));
      bytes += m.size;
    }
    if (adding) {
      const patch = { updatedAt: now };
      if (toCreate.length) patch['stats.files'] = FieldValue.increment(toCreate.length);
      if (newFolders.length) patch['stats.folders'] = FieldValue.increment(newFolders.length);
      if (bytes) patch['stats.bytes'] = FieldValue.increment(bytes);
      tx.update(memRef, patch);
    }
    if (rt.changed || !ticket.migrations?.[MIGRATION_STAMP]) {
      // Only the fields the ticket has: never invent an empty thread.
      const patch = { [`migrations.${MIGRATION_STAMP}`]: now };
      if (Array.isArray(ticket.files)) patch.files = rt.files;
      if (Array.isArray(ticket.recentMessages)) patch.recentMessages = rt.recentMessages;
      tx.update(ticketRef, patch);
    }
    for (const w of pageWrites) tx.update(w.ref, { messages: w.messages });
    return { files: toCreate.length, folders: newFolders.length, copied, refs: refCount };
  });
}
