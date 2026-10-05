/**
 * SearchIndex straight over Firestore — production WITHOUT Typesense.
 *
 * The in-memory index is per process: on Cloud Functions every instance
 * (and every cold start) would hold a different, mostly empty copy, so
 * production must not use it. This index keeps nothing: writes are no-ops
 * and search reads the source of truth, degrading gracefully:
 *
 *   exact key   'ENG-42' / '#eng-42' → keys/{KEY} (following one move), any
 *               readable board
 *   title       prefix range query on `title` per board, as typed and with a
 *               capitalised first letter (Firestore strings are case-sensitive)
 *   recent      the board's most recently active tickets, matched with the
 *               memory index's rules (tokens, key infix, last-word prefix)
 *
 * Bounded: at most MAX_BOARDS boards and RECENT_PER_BOARD tickets each, so
 * one ⌘K keystroke is a handful of small reads. scopedKey answers host
 * 'memory', which tells the SPA to use its own Firestore fallback
 * (frontend/src/lib/search, editor/ticketSearch) — the browser queries
 * Firestore under its rules; nothing here is reachable from the client.
 */
import {
  paths,
  TICKET_KEY_RE,
  type KeyIndex,
  type SearchIndex,
  type SearchQuery,
  type Ticket,
} from '@tm/shared';
import { db } from '../runtime/firebase.js';
import { buildTicketDoc } from './doc.js';
import { memorySearchIndex } from './memory.js';

export const MAX_BOARDS = 25;
export const RECENT_PER_BOARD = 200;
const PREFIX_PER_BOARD = 20;

type Hit = { boardId: string; id: string; ticket: Ticket };

export function firestoreSearchIndex(): SearchIndex {
  return {
    async upsert() {
      /* the tickets themselves are the index */
    },
    async delete() {
      /* ditto */
    },
    async scopedKey(boardIds, expiresAt) {
      // Same contract as the memory index: 'memory' = search from the client's side.
      const payload = { filter_by: `boardId:[${boardIds.join(',')}]`, expires_at: expiresAt };
      return {
        key: 'fs_' + Buffer.from(JSON.stringify(payload)).toString('base64url'),
        host: 'memory',
      };
    },
    async search(q: SearchQuery) {
      if (q.boardIds.length === 0) return { hits: [], found: 0 };
      const allowed = new Set(q.boardIds);
      const boards = q.boardIds.slice(0, MAX_BOARDS);
      const text = (q.q === '*' ? '' : q.q).trim().replace(/^#/, '');

      const found = new Map<string, Hit>();
      const add = (h: Hit) => {
        if (allowed.has(h.boardId)) found.set(h.id, h);
      };
      await Promise.all([
        exactKey(text).then((h) => h && add(h)),
        ...boards.map(async (b) => (await titlePrefix(b, text)).forEach(add)),
        ...boards.map(async (b) => (await recent(b)).forEach(add)),
      ]);

      // Rank with the memory index's rules, over just these candidates.
      const mem = memorySearchIndex();
      for (const { boardId, id, ticket } of found.values()) {
        await mem.upsert(buildTicketDoc({ boardId, ticketId: id }, ticket));
      }
      const res = await mem.search({ ...q, q: text });
      // An exact key always wins, even when the token rules would not rank it first.
      const exact = TICKET_KEY_RE.test(text.toUpperCase())
        ? res.hits.findIndex((h) => h.key === text.toUpperCase())
        : -1;
      if (exact > 0) res.hits.unshift(...res.hits.splice(exact, 1));
      return res;
    },
  };
}

async function exactKey(text: string): Promise<Hit | null> {
  const key = text.toUpperCase();
  if (!TICKET_KEY_RE.test(key)) return null;
  let idx = (await db().doc(paths.key(key)).get()).data() as KeyIndex | undefined;
  if (idx && !idx.deleted && idx.current !== key) {
    idx = (await db().doc(paths.key(idx.current)).get()).data() as KeyIndex | undefined;
  }
  if (!idx || idx.deleted) return null;
  const t = await db().doc(paths.ticket(idx.boardId, idx.ticketId)).get();
  return t.exists ? { boardId: idx.boardId, id: t.id, ticket: t.data() as Ticket } : null;
}

async function titlePrefix(boardId: string, text: string): Promise<Hit[]> {
  if (text.length < 2) return [];
  const variants = [...new Set([text, text[0]!.toUpperCase() + text.slice(1)])];
  const col = db().collection(paths.tickets(boardId));
  const snaps = await Promise.all(
    variants.map((v) =>
      col
        .where('title', '>=', v)
        // U+10FFFF, not U+F8FF: Firestore compares UTF-8 bytes, and emoji sort above U+F8FF.
        .where('title', '<', v + '\u{10ffff}')
        .limit(PREFIX_PER_BOARD)
        .get(),
    ),
  );
  return snaps.flatMap((s) =>
    s.docs.map((d) => ({ boardId, id: d.id, ticket: d.data() as Ticket })),
  );
}

async function recent(boardId: string): Promise<Hit[]> {
  const s = await db()
    .collection(paths.tickets(boardId))
    .orderBy('lastActivityAt', 'desc')
    .limit(RECENT_PER_BOARD)
    .get();
  return s.docs.map((d) => ({ boardId, id: d.id, ticket: d.data() as Ticket }));
}
