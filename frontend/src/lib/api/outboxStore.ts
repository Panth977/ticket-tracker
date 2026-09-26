/**
 * Where persisted outbox entries live between visits: IndexedDB
 * ('tm-outbox' › 'entries', keyed `${uid}:${id}`, so two accounts on one
 * browser never see each other's), falling back to localStorage
 * ('tm.outbox.{uid}') and then memory when neither works (private mode, tests).
 */
import type { OutboxEntry, OutboxStorage } from './outbox.svelte';

/** Entries older than this are not resent (a week-old unsent message is noise). */
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Keep only well-formed, recent entries of this user. */
export function parseEntries(raw: unknown[], uid: string, now = Date.now()): OutboxEntry[] {
  return raw.filter(
    (e): e is OutboxEntry =>
      !!e &&
      typeof e === 'object' &&
      (e as OutboxEntry).uid === uid &&
      typeof (e as OutboxEntry).id === 'string' &&
      typeof (e as OutboxEntry).command === 'string' &&
      !!(e as OutboxEntry).input &&
      typeof (e as OutboxEntry).input === 'object' &&
      typeof (e as OutboxEntry).createdAt === 'number' &&
      now - (e as OutboxEntry).createdAt < OUTBOX_TTL_MS,
  );
}

export function memoryOutboxStorage(): OutboxStorage {
  const m = new Map<string, OutboxEntry>();
  return {
    async load(uid) {
      return parseEntries([...m.values()], uid);
    },
    async save(e) {
      m.set(`${e.uid}:${e.id}`, structuredClone(e));
    },
    async remove(uid, id) {
      m.delete(`${uid}:${id}`);
    },
  };
}

export function localOutboxStorage(ls: Storage): OutboxStorage {
  const key = (uid: string) => `tm.outbox.${uid}`;
  const read = (uid: string): Record<string, OutboxEntry> => {
    try {
      return JSON.parse(ls.getItem(key(uid)) ?? '{}') as Record<string, OutboxEntry>;
    } catch {
      return {};
    }
  };
  const write = (uid: string, all: Record<string, OutboxEntry>) => {
    if (Object.keys(all).length) ls.setItem(key(uid), JSON.stringify(all));
    else ls.removeItem(key(uid));
  };
  return {
    async load(uid) {
      return parseEntries(Object.values(read(uid)), uid);
    },
    async save(e) {
      const all = read(e.uid);
      all[e.id] = e;
      write(e.uid, all);
    },
    async remove(uid, id) {
      const all = read(uid);
      delete all[id];
      write(uid, all);
    },
  };
}

const DB = 'tm-outbox';
const STORE = 'entries';

function idbOutboxStorage(): OutboxStorage {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
    db().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  return {
    async load(uid) {
      // Keys are `${uid}:${id}`: a key range selects this user's entries.
      const rows = await run('readonly', (s) => s.getAll(IDBKeyRange.bound(`${uid}:`, `${uid}:￿`)));
      return parseEntries(rows as unknown[], uid);
    },
    async save(e) {
      await run('readwrite', (s) => s.put(e, `${e.uid}:${e.id}`));
    },
    async remove(uid, id) {
      await run('readwrite', (s) => s.delete(`${uid}:${id}`));
    },
  };
}

/** IndexedDB → localStorage → memory: the first that works; a failing one is abandoned for the next. */
export function createOutboxStorage(): OutboxStorage {
  const chain: OutboxStorage[] = [];
  if (typeof indexedDB !== 'undefined') chain.push(idbOutboxStorage());
  try {
    if (typeof localStorage !== 'undefined') chain.push(localOutboxStorage(localStorage));
  } catch {
    /* blocked */
  }
  chain.push(memoryOutboxStorage());
  let i = 0;
  const guard =
    <A extends unknown[], R>(pick: (s: OutboxStorage) => (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      for (;;) {
        const s = chain[i]!;
        try {
          return await pick(s)(...a);
        } catch (e) {
          if (i >= chain.length - 1) throw e;
          i += 1;
        }
      }
    };
  return {
    load: guard((s) => s.load),
    save: guard((s) => s.save),
    remove: guard((s) => s.remove),
  };
}
