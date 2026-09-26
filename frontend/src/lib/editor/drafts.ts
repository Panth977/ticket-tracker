/**
 * Composer drafts, per person per ticket, in IndexedDB (architecture › Rich
 * text: "Drafts are saved per ticket in IndexedDB"). A draft survives a reload,
 * closing the drawer, and going offline; it is cleared when the message sends.
 *
 * Falls back to memory when IndexedDB is unavailable (private mode, tests).
 */
import { RichTextDocSchema, type RichTextDoc } from '@tm/shared';

export interface DraftAttachment {
  /** Storage path (already uploaded). */
  path: string;
  name: string;
  size: number;
  mime: string;
}

export interface Draft {
  doc: RichTextDoc;
  replyTo: string | null;
  /** Only finished uploads are kept; an in-flight one is lost on reload. */
  attachments: DraftAttachment[];
  savedAt: number;
}

export interface DraftStore {
  get(key: string): Promise<Draft | null>;
  set(key: string, draft: Draft): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Draft key: never share drafts between two accounts on one browser. */
export function draftKey(uid: string, ticketId: string): string {
  return `${uid}:${ticketId}`;
}

/** Drafts older than this are ignored (and removed) on read. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Validate what came out of storage — an old / corrupted record is dropped, not trusted. */
export function parseDraft(raw: unknown, now = Date.now()): Draft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const doc = RichTextDocSchema.safeParse(r.doc);
  if (!doc.success) return null;
  const savedAt = typeof r.savedAt === 'number' ? r.savedAt : 0;
  if (now - savedAt > DRAFT_TTL_MS) return null;
  const attachments = Array.isArray(r.attachments)
    ? r.attachments.filter(
        (a): a is DraftAttachment =>
          !!a &&
          typeof a === 'object' &&
          typeof (a as DraftAttachment).path === 'string' &&
          typeof (a as DraftAttachment).name === 'string' &&
          typeof (a as DraftAttachment).size === 'number' &&
          typeof (a as DraftAttachment).mime === 'string',
      )
    : [];
  return {
    doc: doc.data,
    replyTo: typeof r.replyTo === 'string' && r.replyTo ? r.replyTo : null,
    attachments,
    savedAt,
  };
}

export function memoryDraftStore(): DraftStore {
  const m = new Map<string, Draft>();
  return {
    async get(k) {
      return parseDraft(m.get(k));
    },
    async set(k, d) {
      m.set(k, structuredClone(d));
    },
    async delete(k) {
      m.delete(k);
    },
  };
}

const DB = 'tm-drafts';
const STORE = 'drafts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDraftStore(): DraftStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb());
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
    async get(k) {
      const raw = await run('readonly', (s) => s.get(k));
      const d = parseDraft(raw);
      if (raw && !d) void run('readwrite', (s) => s.delete(k)).catch(() => {});
      return d;
    },
    async set(k, d) {
      // $state proxies cannot be structured-cloned; store plain JSON.
      await run('readwrite', (s) => s.put(JSON.parse(JSON.stringify(d)), k));
    },
    async delete(k) {
      await run('readwrite', (s) => s.delete(k));
    },
  };
}

/** The app's draft store: IndexedDB when it works, memory otherwise. */
function createDraftStore(): DraftStore {
  if (typeof indexedDB === 'undefined') return memoryDraftStore();
  const idb = idbDraftStore();
  const mem = memoryDraftStore();
  let broken = false;
  const guard =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>, g: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (broken) return g(...a);
      try {
        return await f(...a);
      } catch {
        broken = true;
        return g(...a);
      }
    };
  return {
    get: guard(idb.get, mem.get),
    set: guard(idb.set, mem.set),
    delete: guard(idb.delete, mem.delete),
  };
}

export const drafts: DraftStore = createDraftStore();
