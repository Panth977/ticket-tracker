/**
 * Live Firestore queries as Svelte stores — "one store per live query,
 * reference-counted" (docs/plan/architecture.html › The client).
 *
 *   const board = docStore<Board>(paths.board(id));        $board.data?.name
 *   const views = queryStore<View>({ path: paths.views(id), where: [['scope', '==', 'shared']] });
 *
 * Two components asking for the same path/spec share ONE onSnapshot. Every
 * state has { loading, error, data }; documents carry their `id`.
 * Optimistic overlays (./overlay) are applied on top of the server data.
 *
 * LOCAL FIRST (§T). `loading` means "nothing to show yet" — never "no server
 * answer yet". A store whose key the registry still remembers starts from that
 * last state with `loading: false, fromCache: true`, and the listener's first
 * snapshot (itself served from Firestore's IndexedDB cache before any round
 * trip) patches it in place. Only a key nobody has ever resolved begins at
 * `loading: true`.
 */
import {
  collection,
  collectionGroup,
  doc,
  limit as qLimit,
  onSnapshot,
  orderBy as qOrderBy,
  query,
  where as qWhere,
  type DocumentData,
  type Query,
  type WhereFilterOp,
} from 'firebase/firestore';
import { readable, type Readable } from 'svelte/store';
import { getDb } from '$lib/firebase/client';
import { applyOverlays, onOverlayChange } from './overlay';
import { countReads, firstServerSnapshot } from './reads';
import { createRegistry } from './shared';

export type WithId<T> = T & { id: string };

export interface DocState<T> {
  loading: boolean;
  error: Error | null;
  /** null while loading, when missing, or on error. */
  data: WithId<T> | null;
  /** false until the first snapshot says the document exists. */
  exists: boolean;
  /** The snapshot came from the offline cache. */
  fromCache: boolean;
}

export interface QueryState<T> {
  loading: boolean;
  error: Error | null;
  data: WithId<T>[];
  fromCache: boolean;
}

export interface QuerySpec {
  /** Collection path ('boards/b1/views'), or a collection id when `group`. */
  path: string;
  /** collectionGroup query over every collection with this id. */
  group?: boolean;
  where?: [field: string, op: WhereFilterOp, value: unknown][];
  orderBy?: [field: string, dir?: 'asc' | 'desc'][];
  limit?: number;
}

export const registry = createRegistry();

const IDLE_DOC: DocState<never> = {
  loading: false,
  error: null,
  data: null,
  exists: false,
  fromCache: false,
};
const IDLE_QUERY: QueryState<never> = { loading: false, error: null, data: [], fromCache: false };

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * How a remembered state comes back (./shared › GetOptions). It is the last
 * thing this key showed, so it is data — not a loading state — and it is by
 * definition local, hence `fromCache`. A state that never resolved, or one
 * that ended in an error, is refused: those must be asked again, not redrawn.
 */
export function reviveState<
  S extends { loading: boolean; error: Error | null; fromCache: boolean },
>(prev: S): S | null {
  if (prev.loading || prev.error) return null;
  return { ...prev, loading: false, error: null, fromCache: true };
}

/** A live document. `null` path → an idle store (handy for "uid not known yet"). */
export function docStore<T = DocumentData>(path: string | null | undefined): Readable<DocState<T>> {
  if (!path) return readable(IDLE_DOC as DocState<T>);
  const initial: DocState<T> = {
    loading: true,
    error: null,
    data: null,
    exists: false,
    fromCache: false,
  };
  return registry.get<DocState<T>>(
    'd:' + path,
    initial,
    (set) => {
      let base: WithId<T> | null = null;
      let meta = { loading: true, error: null as Error | null, exists: false, fromCache: false };
      const render = () => {
        const data = base ? (applyOverlays(path, base) ?? null) : null;
        set({ ...meta, data });
      };
      const offOverlay = onOverlayChange(render);
      const offSnap = onSnapshot(
        doc(getDb(), path),
        (snap) => {
          // §W's read budget: a cached snapshot never left the tab (./reads).
          if (!snap.metadata.fromCache) countReads('d:' + path, 1);
          base = snap.exists() ? ({ ...(snap.data() as T), id: snap.id } as WithId<T>) : null;
          meta = {
            loading: false,
            error: null,
            exists: snap.exists(),
            fromCache: snap.metadata.fromCache,
          };
          render();
        },
        (err) => {
          base = null;
          meta = { loading: false, error: toError(err), exists: false, fromCache: false };
          render();
        },
      );
      return () => {
        offSnap();
        offOverlay();
      };
    },
    { revive: reviveState },
  );
}

export function specKey(spec: QuerySpec): string {
  return (
    'q:' +
    JSON.stringify([
      spec.path,
      !!spec.group,
      spec.where ?? [],
      spec.orderBy ?? [],
      spec.limit ?? null,
    ])
  );
}

function buildQuery(spec: QuerySpec): Query {
  const db = getDb();
  const base = spec.group ? collectionGroup(db, spec.path) : collection(db, spec.path);
  const parts = [
    ...(spec.where ?? []).map(([f, op, v]) => qWhere(f, op, v)),
    ...(spec.orderBy ?? []).map(([f, d]) => qOrderBy(f, d ?? 'asc')),
    ...(spec.limit ? [qLimit(spec.limit)] : []),
  ];
  return query(base, ...parts);
}

/**
 * A live query. Pass a QuerySpec (preferred: its key is derived) or
 * `{ key, query }` for a hand-built Query. `null` → idle store.
 */
export function queryStore<T = DocumentData>(
  spec: QuerySpec | { key: string; query: () => Query } | null | undefined,
): Readable<QueryState<T>> {
  if (!spec) return readable(IDLE_QUERY as QueryState<T>);
  const key = 'key' in spec ? 'k:' + spec.key : specKey(spec);
  const build = 'key' in spec ? spec.query : () => buildQuery(spec);
  const initial: QueryState<T> = { loading: true, error: null, data: [], fromCache: false };
  return registry.get<QueryState<T>>(
    key,
    initial,
    (set) => {
      let rows: { path: string; data: WithId<T> }[] = [];
      let meta = { loading: true, error: null as Error | null, fromCache: false };
      // §W's read budget: the first server snapshot is the query itself.
      const bill = firstServerSnapshot(key);
      const render = () => {
        const data: WithId<T>[] = [];
        for (const r of rows) {
          const v = applyOverlays(r.path, r.data);
          if (v) data.push(v);
        }
        set({ ...meta, data });
      };
      const offOverlay = onOverlayChange(render);
      let offSnap: () => void = () => {};
      try {
        offSnap = onSnapshot(
          build(),
          (snap) => {
            if (!snap.metadata.fromCache) bill(snap.docChanges().length);
            rows = snap.docs.map((d) => ({
              path: d.ref.path,
              data: { ...(d.data() as T), id: d.id } as WithId<T>,
            }));
            meta = { loading: false, error: null, fromCache: snap.metadata.fromCache };
            render();
          },
          (err) => {
            rows = [];
            meta = { loading: false, error: toError(err), fromCache: false };
            render();
          },
        );
      } catch (err) {
        meta = { loading: false, error: toError(err), fromCache: false };
        render();
      }
      return () => {
        offSnap();
        offOverlay();
      };
    },
    { revive: reviveState },
  );
}
