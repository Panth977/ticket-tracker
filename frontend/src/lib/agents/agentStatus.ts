/**
 * THE LISTENERS BEHIND AGENT HEALTH (agents.html §L3 · §W) — kept apart from
 * ./health, which is pure display logic, so the words and colours can be tested
 * without Firebase.
 *
 * §W MOVED LIVENESS TO THE REALTIME DATABASE. A heartbeat changes once a minute
 * per agent, forever, and every open tab on the board watches it: in Firestore
 * that is a transaction plus a billed document read in every client, for a
 * hundred bytes of truth. So `boards/{b}/agentStatus` is not written any more —
 * the beat is one node at `status/{boardId}/{agentId}/{ticketId|'_'}`
 * (@tm/shared/rtdb › live), where it costs bandwidth instead of operations.
 *
 * ONE onValue PER BOARD, shared by every card, avatar, drawer header and page
 * that asks for the same board — the same contract the Firestore listener had,
 * and the same `QueryState<AgentStatus>` shape, so nothing above this file
 * knows where the beat lives. `toAgentStatus` puts back the nulls the RTDB
 * deletes, and `id` keeps the `{agentId}__{ticketId|'_'}` spelling ./health
 * looks statuses up by.
 *
 * WHAT IS SHOWN IS STILL DERIVED: `deriveAgentHealth` turns the state plus the
 * time since `at` into working · stale · idle · done · error · none, so a
 * 'working' agent goes red by itself when the beats stop. Nothing writes
 * 'this agent went quiet'.
 */
import { onValue, ref } from 'firebase/database';
import { readable, type Readable } from 'svelte/store';
import { agentStatusId, live, statusesOfBoard, type AgentStatus } from '@tm/shared';
import { getRtdb } from '$lib/firebase/client';
import { registry, type QueryState } from '$lib/stores';
import { type Status } from './health';

const IDLE: QueryState<AgentStatus> = {
  loading: false,
  error: null,
  data: [],
  fromCache: false,
};

/**
 * ONE live listener per board over the RTDB status tree. Shared and
 * reference-counted through the same registry the Firestore stores use, so ten
 * components asking for one board is one subscription — and the last value is
 * remembered across a navigation, exactly as before (§T).
 */
export function boardAgentStatus(
  boardId: string | null | undefined,
): Readable<QueryState<AgentStatus>> {
  if (!boardId) return readable(IDLE);
  const initial: QueryState<AgentStatus> = {
    loading: true,
    error: null,
    data: [],
    fromCache: false,
  };
  return registry.get<QueryState<AgentStatus>>('live:status:' + boardId, initial, (set) => {
    try {
      return onValue(
        ref(getRtdb(), live.boardStatus(boardId)),
        (snap) => {
          const rows = statusesOfBoard(
            snap.val() as Record<string, Record<string, unknown>> | null,
          ).map((r) => ({ ...r, id: agentStatusId(r.agentId, r.ticketId) }));
          set({ loading: false, error: null, data: rows, fromCache: false });
        },
        (err: Error) => set({ loading: false, error: err, data: [], fromCache: false }),
      );
    } catch {
      // No RTDB in this build / this browser: no dots, and nothing else breaks.
      set(IDLE);
      return () => {};
    }
  });
}

/** A status plus the board it came from — the Agents page spans boards. */
export type BoardStatus = Status & { boardId: string };

/**
 * Every status about an agent across the boards it is on (the Agents page).
 * One listener per board, all of them shared with whatever else is watching
 * that board.
 */
export function agentStatusAcross(boardIds: readonly string[]): Readable<BoardStatus[]> {
  if (!boardIds.length) return readable([]);
  const stores = boardIds.map((id) => ({ id, store: boardAgentStatus(id) }));
  return readable<BoardStatus[]>([], (set) => {
    const rows = new Map<string, BoardStatus[]>();
    const push = () => set([...rows.values()].flat());
    const offs = stores.map(({ id, store }) =>
      store.subscribe((s) => {
        rows.set(
          id,
          s.data.map((d) => ({ ...d, boardId: id })),
        );
        push();
      }),
    );
    return () => offs.forEach((off) => off());
  });
}
