/**
 * `api.*` for a template (docs/plan/templates.html §C3) — the page answering
 * its worker, AS THE PERSON LOOKING and only for the board the template
 * belongs to. A template can read what that person could read on that board
 * anyway; never another board, never a write. (The one thing a template
 * writes is its submit result, and only when the person presses the button.)
 *
 * Tickets come from the board's live list of active tickets (the store the
 * board screen already keeps), so a card template calling api.* costs no
 * extra reads.
 */
import type { Readable } from 'svelte/store';
import { doc, getDoc } from 'firebase/firestore';
import { paths, type Board, type BoardMember, type KeyIndex, type Ticket } from '@tm/shared';
import { getDb } from '$lib/firebase/client';
import { boardActiveTickets, boardMembers, type QueryState } from '$lib/stores';
import { rankTickets } from '$lib/editor/ticketSearch';
import type { TemplateBridge } from './host';
import { boardInfo, memberInfo, ticketInfo, type MemberInfo, type TicketInfo } from './info';

/** The first loaded value of a live store. */
function loaded<T>(store: Readable<QueryState<T>>, ms = 8000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      queueMicrotask(() => off());
      reject(new Error('Timed out loading the board'));
    }, ms);
    const off = store.subscribe((s) => {
      if (done) return;
      if (s.loading) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => off());
      if (s.error) reject(s.error);
      else resolve(s.data);
    });
  });
}

const STORAGE_MAX = 10_000;

export interface BridgeInput {
  board: Board & { id: string };
  /** The viewer (uid or agent id) and their role. */
  me: { id: string; name: string; email: string; role: string };
  templateId: string;
}

/** The live data a bridge reads; the board screen and the drawer already hold it. */
export function boardSources(boardId: string, uid?: string | null) {
  return {
    tickets: boardActiveTickets(boardId, uid) as Readable<QueryState<Ticket & { id: string }>>,
    members: boardMembers(boardId) as Readable<QueryState<BoardMember>>,
  };
}

export function createBridge(i: BridgeInput): TemplateBridge & {
  /** For hosts that already hold the rows (cards): TicketInfo without a round trip. */
  infoOf: (t: Ticket & { id: string }) => Promise<TicketInfo>;
} {
  const src = boardSources(i.board.id, i.me.id);
  let membersP: Promise<MemberInfo[]> | null = null;
  const members = () =>
    (membersP ??= loaded(src.members).then((ms) =>
      ms.map(memberInfo).sort((a, b) => a.name.localeCompare(b.name)),
    ));
  const memberMap = async () => new Map((await members()).map((m) => [m.id, m]));
  const tickets = () => loaded(src.tickets);
  const info = async (t: Ticket & { id: string }) => ticketInfo(t, i.board, await memberMap());
  const storageKey = (k: string) => `tm:tpl:${i.board.id}:${i.templateId}:${k.slice(0, 100)}`;

  return {
    infoOf: info,
    board: async () => boardInfo(i.board),
    me: async () => ({ ...i.me }),
    members,
    async ticketGet(key) {
      const k = key.trim().toUpperCase().replace(/^#/, '');
      if (!k.startsWith(`${i.board.key}-`)) return null; // this board only
      const live = (await tickets()).find((t) => t.key === k);
      if (live) return info(live);
      const idx = await getDoc(doc(getDb(), paths.key(k)));
      const ticketId = idx.exists() ? (idx.data() as KeyIndex).ticketId : null;
      if (!ticketId || (idx.data() as KeyIndex).boardId !== i.board.id) return null;
      const snap = await getDoc(doc(getDb(), paths.ticket(i.board.id, ticketId)));
      return snap.exists() ? info({ ...(snap.data() as Ticket), id: snap.id }) : null;
    },
    async ticketList(q) {
      const all = await tickets();
      const map = await memberMap();
      const s = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
      const stage = s(q.stage);
      const tag = s(q.tag);
      const priority = s(q.priority);
      const text = s(q.text);
      let who = s(q.assignee);
      if (who === 'me') who = i.me.id.toLowerCase();
      const named = (xs: { id: string; name: string }[], id: string | null, want: string) =>
        !!id &&
        xs.some(
          (x) => x.id === id && (x.id.toLowerCase() === want || x.name.toLowerCase() === want),
        );
      const rows = all.filter(
        (t) =>
          (!stage || named(i.board.stages, t.stageId, stage)) &&
          (!priority || named(i.board.priorities, t.priorityId, priority)) &&
          (!tag || t.tagIds.some((id) => named(i.board.tags, id, tag))) &&
          (!text || t.title.toLowerCase().includes(text)) &&
          (!who ||
            t.assigneeUids.some((id) => {
              const m = map.get(id);
              return (
                id.toLowerCase() === who ||
                m?.email.toLowerCase() === who ||
                m?.name.toLowerCase() === who
              );
            })),
      );
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      const limit = Math.max(1, Math.min(200, typeof q.limit === 'number' ? q.limit : 50));
      return Promise.all(rows.slice(0, limit).map(info));
    },
    async ticketSearch(text, opts) {
      const limit = Math.max(1, Math.min(50, typeof opts.limit === 'number' ? opts.limit : 8));
      return Promise.all(rankTickets(text, await tickets(), limit).map(info));
    },
    async storageGet(k) {
      try {
        const raw = localStorage.getItem(storageKey(k));
        return raw === null ? null : JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async storageSet(k, value) {
      const raw = JSON.stringify(value ?? null);
      if (raw.length > STORAGE_MAX)
        throw new Error(`api.storage.set: at most ${STORAGE_MAX} characters of JSON`);
      if (value === null || value === undefined) localStorage.removeItem(storageKey(k));
      else localStorage.setItem(storageKey(k), raw);
      return true;
    },
  };
}

/** A bridge with nothing behind it — the editor's preview before a board is chosen, and tests. */
export const emptyBridge: TemplateBridge = {
  board: async () => null,
  me: async () => null,
  members: async () => [],
  ticketGet: async () => null,
  ticketList: async () => [],
  ticketSearch: async () => [],
  storageGet: async () => null,
  storageSet: async () => true,
};

/** The template's ctx: plain data, sent with `load` (kept small: no ticket lists). */
export async function contextFor(
  bridge: ReturnType<typeof createBridge>,
  extra: { kind: string; ticket?: TicketInfo | null },
) {
  const [board, me] = await Promise.all([bridge.board(), bridge.me()]);
  return { kind: extra.kind, board, me, ...(extra.ticket ? { ticket: extra.ticket } : {}) };
}
