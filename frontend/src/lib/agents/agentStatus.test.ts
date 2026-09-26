/**
 * §W — liveness comes off the RTDB live tree, not a Firestore collection.
 *
 * What matters here: the node the board subscribes to, the AgentStatus shape
 * that comes back out of it (the RTDB has no nulls, so they are put back), and
 * that ten components asking for one board is ONE subscription.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

interface Sub {
  path: string;
  next: (snap: { val: () => unknown }) => void;
  fail: (e: Error) => void;
  closed: boolean;
}
let subs: Sub[] = [];

vi.mock('firebase/database', () => ({
  ref: (_db: unknown, path: string) => ({ path }),
  onValue: (
    r: { path: string },
    next: (snap: { val: () => unknown }) => void,
    fail: (e: Error) => void,
  ) => {
    const s: Sub = { path: r.path, next, fail, closed: false };
    subs.push(s);
    return () => (s.closed = true);
  },
}));
vi.mock('$lib/firebase/client', () => ({ getRtdb: () => ({}) }));

const { boardAgentStatus, agentStatusAcross } = await import('./agentStatus');
const { registry } = await import('$lib/stores');

const AGENT = 'ag_0000000000000001';
const beat = (over: Record<string, unknown> = {}) => ({
  state: 'working',
  at: 1_700,
  startedAt: 1_000,
  ...over,
});

beforeEach(() => {
  subs = [];
  registry.closeAll();
});

describe('one listener per board, on the live tree', () => {
  it('subscribes to status/{boardId} and nothing above it', () => {
    const off = boardAgentStatus('b1').subscribe(() => {});
    expect(subs.map((s) => s.path)).toEqual(['status/b1']);
    off();
  });

  it('is shared: ten components are one subscription', () => {
    const offs = Array.from({ length: 10 }, () => boardAgentStatus('b1').subscribe(() => {}));
    expect(subs.length).toBe(1);
    offs.forEach((o) => o());
  });

  it('opens nothing without a board', () => {
    const store = boardAgentStatus(null);
    const off = store.subscribe(() => {});
    expect(subs.length).toBe(0);
    expect(get(store)).toMatchObject({ loading: false, data: [] });
    off();
  });
});

describe('what comes back', () => {
  it('turns the tree into AgentStatus rows, nulls and all', () => {
    const store = boardAgentStatus('b1');
    const off = store.subscribe(() => {});
    subs[0]!.next({
      val: () => ({
        [AGENT]: {
          t1: beat({ message: 'Running tests', progress: 0.5, ticketId: 't1' }),
          // '_' is the agent-level beat: no ticket, and no `message` child at
          // all — the RTDB deletes what is written as null.
          _: beat({ state: 'idle' }),
        },
      }),
    });
    const rows = get(store).data;
    expect(rows).toHaveLength(2);
    const onTicket = rows.find((r) => r.ticketId === 't1')!;
    expect(onTicket).toMatchObject({
      agentId: AGENT,
      state: 'working',
      message: 'Running tests',
      progress: 0.5,
      lastBeatAt: 1_700,
      startedAt: 1_000,
      endedAt: null,
    });
    const agentLevel = rows.find((r) => r.ticketId === null)!;
    expect(agentLevel.message).toBeNull();
    expect(agentLevel.progress).toBeNull();
    off();
  });

  it('keeps the {agentId}__{ticketId} id ./health looks statuses up by', () => {
    const store = boardAgentStatus('b1');
    const off = store.subscribe(() => {});
    subs[0]!.next({ val: () => ({ [AGENT]: { t1: beat({ ticketId: 't1' }), _: beat() } }) });
    expect((get(store).data as unknown as { id: string }[]).map((r) => r.id).sort()).toEqual([
      `${AGENT}___`,
      `${AGENT}__t1`,
    ]);
    off();
  });

  it('skips a malformed node rather than dropping the board', () => {
    const store = boardAgentStatus('b1');
    const off = store.subscribe(() => {});
    subs[0]!.next({
      val: () => ({
        [AGENT]: { t1: beat({ ticketId: 't1' }), t2: { state: 'nonsense' } },
        'not-an-agent': { _: beat() },
      }),
    });
    expect(get(store).data).toHaveLength(1);
    off();
  });

  it('an empty tree is an answer, not a loading state', () => {
    const store = boardAgentStatus('b1');
    const off = store.subscribe(() => {});
    subs[0]!.next({ val: () => null });
    expect(get(store)).toMatchObject({ loading: false, error: null, data: [] });
    off();
  });

  it('reports a refused read', () => {
    const store = boardAgentStatus('b1');
    const off = store.subscribe(() => {});
    subs[0]!.fail(new Error('permission_denied'));
    expect(get(store).error).toBeTruthy();
    expect(get(store).data).toEqual([]);
    off();
  });
});

describe('across boards (the Agents page)', () => {
  it('joins one listener per board and stamps where each row came from', () => {
    const store = agentStatusAcross(['b1', 'b2']);
    const off = store.subscribe(() => {});
    expect(subs.map((s) => s.path).sort()).toEqual(['status/b1', 'status/b2']);
    for (const s of subs) s.next({ val: () => ({ [AGENT]: { _: beat() } }) });
    expect(
      get(store)
        .map((r) => r.boardId)
        .sort(),
    ).toEqual(['b1', 'b2']);
    off();
  });

  it('opens nothing for no boards', () => {
    const off = agentStatusAcross([]).subscribe(() => {});
    expect(subs.length).toBe(0);
    off();
  });
});
