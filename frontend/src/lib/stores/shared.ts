/**
 * Reference-counted, keyed stores: one underlying listener per key, however
 * many components subscribe. The listener opens with the first subscriber and
 * closes LINGER_MS after the last one leaves — the short linger stops a
 * navigation (unmount → mount of the same query) from tearing down and
 * re-opening a Firestore listener.
 *
 * It also REMEMBERS the last value of each key it closes (§T, local first).
 * A store that is subscribed again — the board you just came back to — starts
 * from what it last showed instead of from `loading: true`, so the first frame
 * after a navigation draws data and the listener's own first snapshot patches
 * it. `revive` is the owner's chance to say what a remembered value looks like
 * when it is handed back (live.ts clears errors and marks it fromCache), or to
 * refuse it by returning null.
 *
 * The memory is in-process only: it is not a second cache of the data (that is
 * Firestore's IndexedDB), it is the last rendered state, bounded and dropped
 * whole on sign-out.
 *
 * Implements the Svelte store contract, so `$store` works in components.
 */
import type { Readable, Subscriber, Unsubscriber } from 'svelte/store';

export const LINGER_MS = 2000;
/** Keys whose last value is kept. Oldest remembered key is evicted first. */
export const MAX_REMEMBERED = 300;

interface Entry<V> {
  value: V;
  subs: Set<Subscriber<V>>;
  close: (() => void) | null;
  linger: ReturnType<typeof setTimeout> | null;
}

export interface GetOptions<V> {
  /**
   * Turn the last value this key held into the state a new subscriber should
   * start from. Return null to start from `initial` instead.
   */
  revive?: (previous: V) => V | null;
}

export interface SharedRegistry {
  /** Number of keys with an open listener (tests / debugging). */
  openCount(): number;
  /** Close everything now, and forget every remembered value (sign-out). */
  closeAll(): void;
  /** Keys whose last value is remembered (tests / debugging). */
  rememberedCount(): number;
  get<V>(
    key: string,
    initial: V,
    open: (set: (v: V) => void, get: () => V) => () => void,
    options?: GetOptions<V>,
  ): Readable<V>;
}

export function createRegistry(
  lingerMs = LINGER_MS,
  maxRemembered = MAX_REMEMBERED,
): SharedRegistry {
  const entries = new Map<string, Entry<unknown>>();
  const remembered = new Map<string, unknown>();

  function remember(key: string, value: unknown) {
    if (maxRemembered <= 0) return;
    remembered.delete(key); // re-insert: Map keeps insertion order, so this is an LRU
    remembered.set(key, value);
    while (remembered.size > maxRemembered) {
      const oldest = remembered.keys().next();
      if (oldest.done) break;
      remembered.delete(oldest.value);
    }
  }

  function shutdown(key: string, e: Entry<unknown>, keep = true) {
    if (e.linger) clearTimeout(e.linger);
    e.linger = null;
    e.close?.();
    e.close = null;
    entries.delete(key);
    if (keep) remember(key, e.value);
  }

  return {
    openCount: () => [...entries.values()].filter((e) => e.close).length,
    rememberedCount: () => remembered.size,
    closeAll() {
      for (const [k, e] of [...entries]) shutdown(k, e, false);
      remembered.clear();
    },
    get<V>(
      key: string,
      initial: V,
      open: (set: (v: V) => void, get: () => V) => () => void,
      options?: GetOptions<V>,
    ): Readable<V> {
      const entry = (): Entry<V> => {
        let e = entries.get(key) as Entry<V> | undefined;
        if (!e) {
          // Local first: last known state, then the listener patches it.
          let start = initial;
          if (remembered.has(key)) {
            const prev = remembered.get(key) as V;
            const revived = options?.revive ? options.revive(prev) : prev;
            if (revived !== null && revived !== undefined) start = revived;
          }
          e = { value: start, subs: new Set(), close: null, linger: null };
          entries.set(key, e as Entry<unknown>);
        }
        return e;
      };
      return {
        subscribe(run: Subscriber<V>): Unsubscriber {
          const e = entry();
          e.subs.add(run);
          if (e.linger) {
            clearTimeout(e.linger);
            e.linger = null;
          }
          if (!e.close) {
            e.close = open(
              (v) => {
                e.value = v;
                for (const s of [...e.subs]) s(v);
              },
              () => e.value,
            );
          }
          run(e.value);
          return () => {
            e.subs.delete(run);
            if (e.subs.size === 0 && !e.linger) {
              if (lingerMs <= 0) shutdown(key, e as Entry<unknown>);
              else e.linger = setTimeout(() => shutdown(key, e as Entry<unknown>), lingerMs);
            }
          };
        },
      };
    },
  };
}
