/**
 * '#' ticket search — the composer's picker and the Related panel's '+ Link'.
 *
 * Real: Typesense with the person's scoped search key (searchKey command;
 * the key only ever sees boards they can read), prefix search on key and title
 * so '#login' finds ENG-42 and '#42' finds ENG-42.
 *
 * Dev / fake: searchKey answers host 'memory' (no Typesense). Then we search
 * the current board's recent tickets straight from Firestore (rules allow a
 * board reader to list them) and resolve an exact key through keys/{KEY}.
 */
import { collection, doc, getDoc, getDocs, limit, orderBy, query } from 'firebase/firestore';
import {
  paths,
  SEARCH_COLLECTION,
  TICKET_KEY_RE,
  type KeyIndex,
  type StageCategory,
  type Ticket,
  type TicketState,
} from '@tm/shared';
import { command } from '$lib/api';
import { getDb } from '$lib/firebase/client';

export interface TicketHit {
  ticketId: string;
  boardId: string;
  key: string;
  title: string;
  stageCategory?: StageCategory;
  state?: TicketState;
}

/** Best matches first: exact key, key prefix, number, title word prefix, title substring. */
export function rankTickets<T extends Pick<TicketHit, 'key' | 'title'>>(
  q: string,
  list: readonly T[],
  max = 8,
): T[] {
  const query = q.trim().toLowerCase().replace(/^#/, '');
  if (!query) return list.slice(0, max);
  const score = (t: T): number => {
    const key = t.key.toLowerCase();
    const title = t.title.toLowerCase();
    const num = key.split('-')[1] ?? '';
    if (key === query) return 0;
    if (key.startsWith(query)) return 1;
    if (/^\d+$/.test(query) && num.startsWith(query)) return 2;
    if (title.startsWith(query)) return 3;
    if (title.split(/[\s\-_/.,:;()]+/).some((w) => w.startsWith(query))) return 4;
    if (query.length >= 3 && title.includes(query)) return 5;
    return -1;
  };
  return list
    .map((t, i) => ({ t, s: score(t), i }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.t);
}

// ───────────────────────────── Typesense (real) ─────────────────────────────

type ScopedKey = { key: string; host: string; expiresAt: number };
let keyCache: ScopedKey | null = null;
let keyPending: Promise<ScopedKey | null> | null = null;

async function scopedKey(): Promise<ScopedKey | null> {
  if (keyCache && keyCache.expiresAt - 60_000 > Date.now()) return keyCache;
  keyPending ??= command('searchKey', {}, { toast: false })
    .then((r): ScopedKey | null => (keyCache = r))
    .catch(() => null)
    .finally(() => (keyPending = null));
  return keyPending;
}

async function typesense(
  k: { key: string; host: string },
  q: string,
  max: number,
): Promise<TicketHit[]> {
  const url = new URL(
    `${k.host.replace(/\/$/, '')}/collections/${SEARCH_COLLECTION}/documents/search`,
  );
  url.searchParams.set('q', q);
  url.searchParams.set('query_by', 'key,title');
  url.searchParams.set('prefix', 'true');
  url.searchParams.set('infix', 'always,off');
  url.searchParams.set('per_page', String(max));
  const res = await fetch(url, { headers: { 'X-TYPESENSE-API-KEY': k.key } });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const body = (await res.json()) as { hits?: { document: Record<string, unknown> }[] };
  return (body.hits ?? []).map(({ document: d }) => ({
    ticketId: String(d.id),
    boardId: String(d.boardId),
    key: String(d.key),
    title: String(d.title),
    stageCategory: d.stageCategory as StageCategory,
    state: d.state as TicketState,
  }));
}

// ─────────────────────────── Firestore (fake / dev) ───────────────────────────

const boardCache = new Map<string, { at: number; list: Promise<TicketHit[]> }>();

function recentTickets(boardId: string): Promise<TicketHit[]> {
  const hit = boardCache.get(boardId);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const list = getDocs(
    query(
      collection(getDb(), paths.tickets(boardId)),
      orderBy('lastActivityAt', 'desc'),
      limit(300),
    ),
  )
    .then((s) =>
      s.docs.map((d) => {
        const t = d.data() as Ticket;
        return {
          ticketId: d.id,
          boardId,
          key: t.key,
          title: t.title,
          stageCategory: t.stageCategory,
          state: t.state,
        };
      }),
    )
    .catch(() => [] as TicketHit[]);
  boardCache.set(boardId, { at: Date.now(), list });
  return list;
}

/** '#OPS-7' on another board: keys/ is readable by anyone signed in; the ticket only if I can read its board. */
export async function lookupKey(key: string): Promise<TicketHit | null> {
  try {
    const k = await getDoc(doc(getDb(), paths.key(key.toUpperCase())));
    if (!k.exists()) return null;
    const idx = k.data() as KeyIndex;
    if (idx.deleted) return null;
    const t = await getDoc(doc(getDb(), paths.ticket(idx.boardId, idx.ticketId)));
    if (!t.exists()) return null;
    const d = t.data() as Ticket;
    return {
      ticketId: t.id,
      boardId: idx.boardId,
      key: d.key,
      title: d.title,
      stageCategory: d.stageCategory,
      state: d.state,
    };
  } catch {
    return null;
  }
}

async function fallback(q: string, boardId: string | null, max: number): Promise<TicketHit[]> {
  const local = boardId ? rankTickets(q, await recentTickets(boardId), max) : [];
  const typed = q.trim().replace(/^#/, '').toUpperCase();
  if (TICKET_KEY_RE.test(typed) && !local.some((t) => t.key === typed)) {
    const exact = await lookupKey(typed);
    if (exact) return [exact, ...local].slice(0, max);
  }
  return local;
}

/**
 * Search tickets the person can see. `boardId` = the board being worked on
 * (its tickets rank first in the dev fallback). Never throws.
 */
export async function searchTickets(
  q: string,
  opts: { boardId?: string | null; exclude?: readonly string[]; max?: number } = {},
): Promise<TicketHit[]> {
  const max = opts.max ?? 8;
  const drop = new Set(opts.exclude ?? []);
  let hits: TicketHit[];
  const k = q.trim() ? await scopedKey() : null;
  if (k && k.host && k.host !== 'memory') {
    try {
      hits = await typesense(k, q.trim().replace(/^#/, ''), max + drop.size);
    } catch {
      hits = await fallback(q, opts.boardId ?? null, max + drop.size);
    }
  } else {
    hits = await fallback(q, opts.boardId ?? null, max + drop.size);
  }
  return hits.filter((h) => !drop.has(h.ticketId)).slice(0, max);
}

/** Forget cached lists (after creating a ticket, say). */
export function invalidateTicketSearch(boardId?: string) {
  if (boardId) boardCache.delete(boardId);
  else boardCache.clear();
}
