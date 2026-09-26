/**
 * THE INCREMENTAL QUERY (docs/plan/agents.html §W) — "a refresh pays only for
 * what changed".
 *
 * A live query bills one read per document the SERVER returns, so the board's
 * `state == 'active'` listener paid for every card on every cold open. But the
 * cards are already on the device: Firestore's persistent IndexedDB cache holds
 * the last snapshot of that very query. What the cache cannot tell us is
 * whether it is still true.
 *
 * So a warm open is two halves:
 *
 *   1. SEED — `getDocsFromCache(cold)`. Local, free, synchronous-ish, and it is
 *      the same result set the previous visit ended on.
 *   2. DELTA — one listener on `updatedAt > watermark`, where the watermark is
 *      the newest `updatedAt` this device has seen on the board
 *      (lib/boot/pointer › readSynced). An unchanged board answers with no
 *      documents: Firestore's minimum, ONE read, whatever the board's size.
 *
 * The delta carries no `state` filter on purpose — a ticket that LEAVES the
 * active set has to arrive so it can be dropped, and it would not if the query
 * asked only for active ones. `keep` then decides, in the browser, what the
 * caller wanted. (It is also why the delta needs no composite index: one
 * inequality on one field.)
 *
 * A COLD open — no watermark, an empty cache, a watermark older than
 * SYNC_MAX_AGE_MS, or a bumped SYNC_VERSION — is the plain listener on the
 * cold query, exactly as before, and it writes the watermark that makes the
 * next open a delta. That is also the answer to hard deletes, which no
 * `updatedAt >` query can report: see SYNC_MAX_AGE_MS in lib/boot/pointer.
 */
import {
  collection,
  getDocsFromCache,
  onSnapshot,
  query,
  where as qWhere,
  type DocumentData,
  type Query,
  type QueryConstraint,
  type QuerySnapshot,
  type WhereFilterOp,
} from 'firebase/firestore';
import { readable, type Readable } from 'svelte/store';
import { getDb } from '$lib/firebase/client';
import { forgetSynced, noteSynced, readSynced } from '$lib/boot/pointer';
import { applyOverlays, onOverlayChange } from './overlay';
import { firstServerSnapshot } from './reads';
import { registry, reviveState, type QueryState, type WithId } from './live';

export interface DeltaSpec<T> {
  /** One store per scope; the registry shares and ref-counts by this key. */
  key: string;
  /** The collection the rows live in ('boards/b1/tickets'). */
  path: string;
  /** The account whose pointer holds the watermark. */
  uid: string;
  /** What the watermark is kept under (the board id). */
  scope: string;
  /** The full result set, as one server query — used on a cold open and to seed. */
  cold: [field: string, op: WhereFilterOp, value: unknown][];
  /** The field the watermark is read from. Must be written on every change. */
  stamp: string;
  /** Which of the delta's rows the caller actually wants. */
  keep: (row: WithId<T>) => boolean;
}

const IDLE: QueryState<never> = { loading: false, error: null, data: [], fromCache: false };

const EMPTY = new Map<string, { path: string; data: never }>();

function constraints(spec: DeltaSpec<unknown>): QueryConstraint[] {
  return spec.cold.map(([f, op, v]) => qWhere(f, op, v));
}

function stampOf(row: Record<string, unknown>, field: string): number {
  const v = row[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * A live query that pays for what changed. The state it hands out is the same
 * `QueryState<T>` every other store uses, overlays and all, so a caller cannot
 * tell which half answered.
 */
export function deltaQueryStore<T = DocumentData>(
  spec: DeltaSpec<T> | null | undefined,
): Readable<QueryState<T>> {
  if (!spec) return readable(IDLE as QueryState<T>);
  const s = spec;
  const initial: QueryState<T> = { loading: true, error: null, data: [], fromCache: false };
  return registry.get<QueryState<T>>(
    'delta:' + s.key,
    initial,
    (set) => {
      let rows = new Map<string, { path: string; data: WithId<T> }>(EMPTY as never);
      let meta = { loading: true, error: null as Error | null, fromCache: false };
      /** The newest stamp we can prove the server has shown us. */
      let mark = 0;
      let stopped = false;
      let offSnap: () => void = () => {};

      const render = () => {
        const data: WithId<T>[] = [];
        for (const r of rows.values()) {
          const v = applyOverlays(r.path, r.data);
          if (v) data.push(v);
        }
        set({ ...meta, data });
      };
      const offOverlay = onOverlayChange(render);

      const put = (snap: QuerySnapshot, filter: boolean) => {
        for (const d of snap.docs) {
          const data = { ...(d.data() as T), id: d.id } as WithId<T>;
          if (filter && !s.keep(data)) {
            rows.delete(d.id);
            continue;
          }
          rows.set(d.id, { path: d.ref.path, data });
          mark = Math.max(mark, stampOf(d.data(), s.stamp));
        }
      };

      const listen = (q: Query, delta: boolean) => {
        // The first server snapshot is the query: an unchanged board's delta
        // sends no documents and still costs Firestore's minimum of one read.
        const bill = firstServerSnapshot('delta:' + s.key);
        offSnap = onSnapshot(
          q,
          (snap) => {
            if (!snap.metadata.fromCache) bill(snap.docChanges().length);
            if (delta) {
              // Merge: a row that no longer belongs is dropped, a row the
              // server deleted comes as `removed`.
              for (const ch of snap.docChanges()) {
                if (ch.type === 'removed') rows.delete(ch.doc.id);
              }
              put(snap, true);
            } else {
              // The cold listener OWNS the set: whatever it says is the truth.
              rows = new Map();
              put(snap, false);
            }
            meta = { loading: false, error: null, fromCache: snap.metadata.fromCache };
            // Only a SERVER snapshot may move the watermark: a cached one
            // proves nothing about what the server has since done.
            if (!snap.metadata.fromCache) noteSynced(s.uid, s.scope, mark);
            render();
          },
          (err) => {
            meta = {
              loading: false,
              error: err instanceof Error ? err : new Error(String(err)),
              fromCache: false,
            };
            // A refused or mis-indexed delta must not leave a half-synced
            // watermark behind, or every future open would fail the same way:
            // drop it, so the next one is the plain full query.
            if (delta) forgetSynced(s.uid, s.scope);
            rows = new Map();
            render();
          },
        );
      };

      void (async () => {
        const col = collection(getDb(), s.path);
        const cold = query(col, ...constraints(s as DeltaSpec<unknown>));
        let since = readSynced(s.uid, s.scope);
        if (since > 0) {
          try {
            const seed = await getDocsFromCache(cold);
            if (seed.empty) since = 0;
            else {
              put(seed, false);
              mark = Math.max(mark, since);
              meta = { loading: false, error: null, fromCache: true };
              render();
            }
          } catch {
            // No IndexedDB (private mode), or the cache was cleared.
            since = 0;
            rows = new Map();
          }
        }
        if (stopped) return;
        if (since > 0) listen(query(col, qWhere(s.stamp, '>', since)), true);
        else listen(cold, false);
      })();

      return () => {
        stopped = true;
        offSnap();
        offOverlay();
      };
    },
    { revive: reviveState },
  );
}
