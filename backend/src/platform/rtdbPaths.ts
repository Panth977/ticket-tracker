/**
 * THE LIVE TREE, from the server (docs/plan/agents.html §W).
 *
 * The shapes and the paths are in @tm/shared/rtdb; this is the only place the
 * backend touches them with the Admin SDK. Three rules run through it:
 *
 *   ONE WRITE PER COMMAND. The RTDB lives in asia-southeast1 while the
 *   functions live in asia-south1, so every round trip is ~40 ms of billed
 *   CPU spent waiting. A command may bump ONE node; the heartbeat's own write
 *   is that command's work, and `rev` / `wake` are one multi-path update each.
 *
 *   LIVENESS MUST NEVER FAIL A CHANGE. A rev bump or a wake is a hint: if the
 *   database is unreachable the change still happened, and the watcher's own
 *   backstop poll picks it up. `live()` logs and swallows. The heartbeat is
 *   the exception — it IS the change, so it throws.
 *
 *   NULLS DELETE. Writing null removes a child, so a beat that clears its
 *   message writes `null` on purpose and the reader puts the null back
 *   (toAgentStatus).
 */
import {
  live,
  LiveStatusSchema,
  statusesOfBoard,
  statusKey,
  toAgentStatus,
  type AgentStatus,
  type LiveStatus,
} from '@tm/shared';
import { rtdbAdmin } from '../runtime/firebase.js';

/** A hint that must never fail the change that produced it. */
export async function liveSafe(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    // Not an error for the caller: the watcher's backstop poll still sees it.
    console.warn(`[live] ${what} failed (ignored)`, e);
  }
}

// ─── heartbeat status ────────────────────────────────────────────────────────

/**
 * Write one beat, atomically deciding whether it continues the current run.
 * An RTDB transaction is one optimistic round trip, and only the agent itself
 * (or its owner's tooling) ever writes this node, so contention is nil.
 *
 * `startedAt` is kept while the run continues and reset when work resumes
 * after a 'done' / 'error' beat; `endedAt` is set by those beats and cleared
 * when work resumes (§L3).
 */
export async function beat(
  boardId: string,
  agentId: string,
  ticketId: string | null,
  b: { state: LiveStatus['state']; message: string | null; progress: number | null; at: number },
): Promise<AgentStatus> {
  const ref = rtdbAdmin().ref(live.status(boardId, agentId, ticketId));
  const ends = b.state === 'done' || b.state === 'error';
  const res = await ref.transaction((current: unknown) => {
    const parsed = LiveStatusSchema.safeParse(current);
    const prev = parsed.success ? parsed.data : null;
    // No previous beat, or the last run has ended → this beat starts a new run.
    const resumed = !prev || (prev.endedAt ?? null) !== null;
    const node: Record<string, unknown> = {
      state: b.state,
      at: b.at,
      startedAt: resumed || !prev ? b.at : prev.startedAt,
      // null removes the child — which is exactly 'no message', 'not ended'.
      message: b.message,
      progress: b.progress,
      endedAt: ends ? b.at : null,
      ticketId,
    };
    return node;
  });
  const node = LiveStatusSchema.parse(res.snapshot.val());
  return toAgentStatus(agentId, ticketId, node);
}

/** One beat stream, or null when the agent has never beaten here. */
export async function readStatus(
  boardId: string,
  agentId: string,
  ticketId: string | null,
): Promise<AgentStatus | null> {
  const snap = await rtdbAdmin()
    .ref(live.status(boardId, agentId, ticketId))
    .get();
  const parsed = LiveStatusSchema.safeParse(snap.val());
  return parsed.success ? toAgentStatus(agentId, ticketId, parsed.data) : null;
}

/** Every beat stream on one board. ~100 bytes a row: one read, whole board. */
export async function readBoardStatuses(boardId: string): Promise<AgentStatus[]> {
  const snap = await rtdbAdmin().ref(live.boardStatus(boardId)).get();
  return statusesOfBoard(snap.val() as Record<string, Record<string, unknown>> | null);
}

/**
 * THE WHOLE status tree, board by board — what the silence sweep reads instead
 * of a Firestore collection-group query. Fifty boards of live agents is a few
 * kilobytes, and it costs zero operations.
 */
export async function readAllStatuses(): Promise<
  { boardId: string; status: AgentStatus; key: string }[]
> {
  const snap = await rtdbAdmin().ref(live.statusRoot()).get();
  const tree = (snap.val() ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const out: { boardId: string; status: AgentStatus; key: string }[] = [];
  for (const [boardId, board] of Object.entries(tree)) {
    for (const row of statusesOfBoard(board)) {
      const { key, ...status } = row;
      out.push({ boardId, status, key });
    }
  }
  return out;
}

/** Drop everything an agent has said on a board (it left, or the board is gone). */
export const clearAgentStatus = (boardId: string, agentId: string): Promise<void> =>
  rtdbAdmin().ref(live.agentStatus(boardId, agentId)).remove();

export const clearBoardLive = async (boardId: string): Promise<void> => {
  const r = rtdbAdmin();
  await Promise.all([
    r.ref(live.boardStatus(boardId)).remove(),
    r.ref(live.rev(boardId)).remove(),
    r.ref(live.boardSilence(boardId)).remove(),
  ]);
};

// ─── the board revision, and waking an agent ─────────────────────────────────

/**
 * 'Something on this board changed' — ONE ~40-byte write, after the command
 * has already succeeded. Watchers see it move and then ask Firestore for the
 * delta; nothing about the change itself travels through here, so this node
 * can be read by anyone who can read the board.
 */
export const bumpBoardRev = (boardId: string, by: string | null, at: number): Promise<void> =>
  liveSafe(`rev ${boardId}`, () =>
    rtdbAdmin()
      .ref(live.rev(boardId))
      .set({ at, ...(by ? { by } : {}) }),
  );

/**
 * COMMANDS THAT DO NOT MOVE A BOARD'S REVISION.
 *
 *   agentHeartbeat  its own status node IS the signal, and a beat changes
 *                   nothing a watcher would re-read tickets for. Bumping here
 *                   would wake every watcher of the board once a minute per
 *                   agent — exactly the polling §W is removing.
 *   ping            not a change at all.
 *
 * Everything else that names a board in its request moves it. A rev bump does
 * not claim a ticket changed: it says 'ask again'. A watcher answers with one
 * `updatedAt > lastSynced` query, which costs one Firestore read when nothing
 * it cares about moved — cheaper than the bookkeeping needed to be precise.
 */
const NO_REV: ReadonlySet<string> = new Set(['agentHeartbeat', 'ping']);

/** Does this command move rev/{boardId}? (Exported for the tests.) */
export const bumpsBoardRev = (command: string): boolean => !NO_REV.has(command);

/**
 * THE COMMAND LAYER'S ONE LIVE WRITE (§W), called by the runner after a
 * command has succeeded and its response has been validated.
 *
 * It is awaited: ~40 ms to a database in the next region, on a call that
 * already costs ~250 ms, buys a watcher that hears about the change NOW
 * instead of at its next backstop poll. Work left unawaited in a Cloud
 * Function may simply not run — a dropped bump would be a silent stall, so
 * this is the wrong place to save the round trip. It can never fail the
 * command (liveSafe).
 */
export async function markCommandChange(
  command: string,
  input: unknown,
  ctx: { actor: string; now: number },
): Promise<void> {
  if (!bumpsBoardRev(command)) return;
  const boardId = (input as { boardId?: unknown } | null | undefined)?.boardId;
  // A command with no board in its request changes nothing a board watches
  // (profileUpdate, apiKeyCreate …); boardCreate's board has no watchers yet.
  if (typeof boardId !== 'string' || !boardId) return;
  await bumpBoardRev(boardId, ctx.actor, ctx.now);
}

/**
 * 'There is something in your inbox' — one multi-path update for however many
 * agents an event reached, so ten recipients are still one write.
 */
export function wakeAgents(
  agentIds: readonly string[],
  at: number,
  boardId?: string | null,
): Promise<void> {
  const ids = [...new Set(agentIds)];
  if (!ids.length) return Promise.resolve();
  const patch: Record<string, unknown> = {};
  for (const id of ids) patch[live.wake(id)] = { at, ...(boardId ? { boardId } : {}) };
  return liveSafe(`wake ${ids.join(',')}`, () => rtdbAdmin().ref().update(patch));
}

// ─── the silence sweep's bookkeeping (server-only subtree) ───────────────────

/**
 * WHY A SEPARATE SUBTREE. 'When was the owner last told this agent went quiet'
 * is the sweep's business, not the agent's: keeping it under `silence/` means
 * the status node stays ~100 bytes, a client that overwrites its own status
 * cannot erase (or forge) the marker, and the rules can close the whole
 * subtree to clients in one line.
 */
export async function readSilenceMarks(): Promise<Map<string, number>> {
  const snap = await rtdbAdmin().ref(live.silenceRoot()).get();
  const tree = (snap.val() ?? {}) as Record<
    string,
    Record<string, Record<string, { notifiedAt?: unknown }>>
  >;
  const out = new Map<string, number>();
  for (const [boardId, agents] of Object.entries(tree)) {
    for (const [agentId, streams] of Object.entries(agents ?? {})) {
      for (const [k, mark] of Object.entries(streams ?? {})) {
        const at = mark?.notifiedAt;
        if (typeof at === 'number') out.set(`${boardId}/${agentId}/${k}`, at);
      }
    }
  }
  return out;
}

export const silenceMarkKey = (boardId: string, agentId: string, ticketId: string | null): string =>
  `${boardId}/${agentId}/${statusKey(ticketId)}`;

/**
 * Drop beat streams and silence marks the sweep has decided are no longer
 * worth keeping — ONE multi-path removal, or no write at all when there is
 * nothing to drop. `marks` are the map keys readSilenceMarks() hands out.
 */
export async function pruneLive(
  streams: readonly { boardId: string; agentId: string; ticketId: string | null }[],
  marks: readonly string[],
): Promise<number> {
  const patch: Record<string, null> = {};
  for (const s of streams) patch[live.status(s.boardId, s.agentId, s.ticketId)] = null;
  for (const k of marks) patch[`${live.silenceRoot()}/${k}`] = null;
  const n = Object.keys(patch).length;
  if (!n) return 0;
  await liveSafe(`prune ${n}`, () => rtdbAdmin().ref().update(patch));
  return n;
}

export const markSilenceNotified = (
  boardId: string,
  agentId: string,
  ticketId: string | null,
  at: number,
): Promise<void> =>
  rtdbAdmin()
    .ref(live.silence(boardId, agentId, ticketId))
    .set({ notifiedAt: at });
