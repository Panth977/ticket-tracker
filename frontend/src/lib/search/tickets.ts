/**
 * Ticket search for ⌘K and the '#' picker.
 *
 *   searchTickets('login')  → [{ key: 'ENG-42', title: 'Fix login redirect', … }]
 *
 * PRODUCTION: `searchKey` mints a Typesense key scoped to the boards I can
 * read (filter_by boardId:[…], 1h); the browser queries Typesense directly
 * with it (app/db.json › tickets index). The key is cached until a minute
 * before it expires.
 *
 * DEV / FALLBACK: when searchKey answers host 'memory' (no Typesense
 * configured — the in-process index lives in the Functions emulator, out of
 * the browser's reach) or fails, we search the tickets of my boards straight
 * from Firestore (rule-provable: canRead per board) with the same matching
 * rules (./match). Results are cached briefly so typing does not re-read.
 */
import { collection, getDocs, limit as qLimit, query, where } from 'firebase/firestore';
import { get } from 'svelte/store';
import {
  paths,
  SEARCH_COLLECTION,
  type StageCategory,
  type Ticket,
  type TicketState,
} from '@tm/shared';
import { readState } from '$lib/ticket/state';
import { command } from '$lib/api';
import { auth } from '$lib/firebase/auth.svelte';
import { getDb } from '$lib/firebase/client';
import { myBoards } from '$lib/stores/app';
import { rank } from './match';

export interface TicketHit {
  id: string;
  boardId: string;
  key: string;
  title: string;
  stageCategory: StageCategory;
  state: TicketState;
  updatedAt: number;
}

export interface SearchOptions {
  limit?: number;
  /** Only these boards (e.g. the '#' picker on one board). */
  boardIds?: string[];
  /** Include archived tickets (default: active only). */
  includeClosed?: boolean;
  signal?: AbortSignal;
}

// ── scoped key ────────────────────────────────────────────────────────────
interface ScopedKey {
  key: string;
  host: string;
  expiresAt: number;
}
let keyCache: { uid: string; at: number; value: Promise<ScopedKey | null> } | null = null;
const KEY_MARGIN = 60_000;
/** After a failure (or 'memory'), don't ask again for a while. */
const NO_KEY_RETRY = 5 * 60_000;

function isRemote(k: ScopedKey | null): k is ScopedKey {
  return !!k && /^https?:\/\//.test(k.host);
}

async function scopedKey(uid: string): Promise<ScopedKey | null> {
  const now = Date.now();
  if (keyCache && keyCache.uid === uid) {
    const v = await keyCache.value;
    if (v ? v.expiresAt - KEY_MARGIN > now : now - keyCache.at < NO_KEY_RETRY) return v;
  }
  const value = command('searchKey', {}, { toast: false }).then(
    (r) => r as ScopedKey,
    () => null,
  );
  keyCache = { uid, at: now, value };
  return value;
}

/** Forget the key (sign-out, or a board was joined and the scope is stale). */
export function resetSearchKey() {
  keyCache = null;
  localCache.clear();
}

// ── Typesense ─────────────────────────────────────────────────────────────
const inFilter = (field: string, values: readonly string[]) =>
  `${field}:=[${values.map((v) => '`' + v.replace(/`/g, '') + '`').join(',')}]`;

async function typesense(k: ScopedKey, q: string, o: SearchOptions): Promise<TicketHit[]> {
  const filters: string[] = [];
  if (o.boardIds?.length) filters.push(inFilter('boardId', o.boardIds));
  if (!o.includeClosed) filters.push(inFilter('state', ['active']));
  const params = new URLSearchParams({
    q: q.trim() || '*',
    query_by: 'key,title,text',
    query_by_weights: '4,2,1',
    infix: 'always,off,off',
    prefix: 'true,true,true',
    num_typos: '0,1,1',
    sort_by: '_text_match:desc,updatedAt:desc',
    per_page: String(o.limit ?? 10),
    include_fields: 'id,boardId,key,title,stageCategory,state,updatedAt',
  });
  if (filters.length) params.set('filter_by', filters.join(' && '));
  const res = await fetch(
    `${k.host.replace(/\/$/, '')}/collections/${SEARCH_COLLECTION}/documents/search?${params}`,
    { headers: { 'X-TYPESENSE-API-KEY': k.key }, signal: o.signal },
  );
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const body = (await res.json()) as { hits?: { document: TicketHit }[] };
  return (body.hits ?? []).map((h) => h.document);
}

// ── Firestore fallback ────────────────────────────────────────────────────
const LOCAL_TTL = 60_000;
const MAX_BOARDS = 25;
const PER_BOARD = 500;
const localCache = new Map<string, { at: number; value: Promise<TicketHit[]> }>();

function boardTickets(boardId: string, includeClosed: boolean): Promise<TicketHit[]> {
  const ck = `${boardId}:${includeClosed}`;
  const hit = localCache.get(ck);
  if (hit && Date.now() - hit.at < LOCAL_TTL) return hit.value;
  const col = collection(getDb(), paths.tickets(boardId));
  const q = includeClosed
    ? query(col, qLimit(PER_BOARD))
    : query(col, where('state', '==', 'active'), qLimit(PER_BOARD));
  const value = getDocs(q).then(
    (snap) =>
      snap.docs.map((d) => {
        const t = d.data() as Ticket;
        return {
          id: d.id,
          boardId,
          key: t.key,
          title: t.title,
          stageCategory: t.stageCategory,
          state: readState(t.state),
          updatedAt: t.updatedAt ?? t.createdAt ?? 0,
        };
      }),
    () => [] as TicketHit[],
  );
  localCache.set(ck, { at: Date.now(), value });
  return value;
}

async function local(uid: string, q: string, o: SearchOptions): Promise<TicketHit[]> {
  const boards = get(myBoards(uid)).data.filter((b) => b.archivedAt == null);
  const ids = (o.boardIds?.length ? boards.filter((b) => o.boardIds!.includes(b.id)) : boards)
    .slice(0, MAX_BOARDS)
    .map((b) => b.id);
  const all = (await Promise.all(ids.map((id) => boardTickets(id, !!o.includeClosed)))).flat();
  return rank(q, all, o.limit ?? 10);
}

/** Search tickets I can read. Never throws: an unreachable index yields the fallback, then []. */
export async function searchTickets(q: string, o: SearchOptions = {}): Promise<TicketHit[]> {
  const uid = auth.uid;
  if (!uid) return [];
  const k = await scopedKey(uid);
  if (isRemote(k)) {
    try {
      return await typesense(k, q, o);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return [];
      /* fall through to Firestore */
    }
  }
  try {
    return await local(uid, q, o);
  } catch {
    return [];
  }
}
