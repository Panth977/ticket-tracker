/**
 * Where the rows live: SQLite FILES (shards), one TABLE per collection id,
 * one ROW per document.
 *
 *   <dir>/root.sqlite                users, agents, invites, keys, the board
 *                                    and memory DOCUMENTS themselves, …
 *   <dir>/boards/<boardId>.sqlite    everything BELOW boards/<boardId>
 *                                    (tickets, messages, members, views, …)
 *   <dir>/memories/<memoryId>.sqlite everything below memories/<memoryId>
 *   <dir>/artifacts/<artifactId>.sqlite  everything below artifacts/<artifactId>
 *
 * So a board, a memory or an artifact (dashboard) is one file: deleting it
 * is unlinking the file, backing one up is copying it.
 *
 * A table:  c_<collectionId> (parent, id, doc, v, ct, ut)
 *   parent  the parent document's path ('' at the top level)
 *   id      the document id
 *   doc     the whole document as JSON (values.ts codec)
 *   v       version, bumped on every write (optimistic transactions)
 *   ct, ut  create / update time, epoch ms
 * Indexes are expressions over `doc` (json_extract), generated from
 * firestore.indexes.json — the same file that indexes Firestore, so one
 * declaration indexes both stores. The query compiler emits the identical
 * expression, which is how SQLite matches a query to an index.
 *
 * TM_DB_DIR=':memory:' keeps every shard in memory (tests).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite is loaded on first use, never at import: the Firebase deploy
// imports this module (statically, via src/db/index.ts) and must not need it.
type SqliteValue = null | number | bigint | string | Uint8Array;
interface StatementSync {
  all(...params: SqliteValue[]): Record<string, SqliteValue>[];
  get(...params: SqliteValue[]): Record<string, SqliteValue> | undefined;
  run(...params: SqliteValue[]): { changes: number | bigint };
}
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}
type DatabaseSyncCtor = new (path: string) => DatabaseSync;

let Ctor: DatabaseSyncCtor | undefined;
function sqlite(): DatabaseSyncCtor {
  if (!Ctor) {
    const mod = process.getBuiltinModule?.('node:sqlite') as
      { DatabaseSync: DatabaseSyncCtor } | undefined;
    if (!mod) throw new Error('TM_DB=sqlite needs Node ≥ 22.13 (node:sqlite)');
    Ctor = mod.DatabaseSync;
  }
  return Ctor;
}

/** The shard kinds: a document of one of these collections owns a file for its subtree. */
export const SHARD_KINDS = ['boards', 'memories', 'artifacts'] as const;
export const ROOT = 'root';

/** 'root' or '<kind>/<id>' for a document or collection path. */
export function shardOf(path: string): string {
  const segs = path.split('/');
  if (segs.length >= 3 && (SHARD_KINDS as readonly string[]).includes(segs[0]!))
    return `${segs[0]}/${segs[1]}`;
  return ROOT;
}

export const tableName = (collectionId: string) => `"c_${collectionId.replace(/"/g, '""')}"`;

/** JSON path of a field ('$."a"."b"'). The SAME text in an index and in a query. */
export function jsonPath(segments: readonly string[]): string {
  return '$' + segments.map((s) => `."${s.replace(/"/g, '\\"')}"`).join('');
}
export const fieldExpr = (segments: readonly string[]) =>
  `json_extract(doc, '${jsonPath(segments).replace(/'/g, "''")}')`;

// ─── index spec (firestore.indexes.json) ────────────────────────────────────

interface IndexSpec {
  collectionGroup: string;
  queryScope?: 'COLLECTION' | 'COLLECTION_GROUP';
  fields: { fieldPath: string; order?: 'ASCENDING' | 'DESCENDING'; arrayConfig?: string }[];
}
let indexSpecs: Map<string, IndexSpec[]> | undefined;

function specsFor(collectionId: string): IndexSpec[] {
  if (!indexSpecs) {
    indexSpecs = new Map();
    try {
      // backend/firestore.indexes.json — two levels above src/db/sqlite and lib/db/sqlite alike.
      const file = fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url));
      const json = JSON.parse(readFileSync(process.env.TM_DB_INDEXES || file, 'utf8')) as {
        indexes?: IndexSpec[];
      };
      for (const ix of json.indexes ?? []) {
        const list = indexSpecs.get(ix.collectionGroup) ?? [];
        list.push(ix);
        indexSpecs.set(ix.collectionGroup, list);
      }
    } catch {
      // No index file: queries still answer, by scanning.
    }
  }
  return indexSpecs.get(collectionId) ?? [];
}

function indexDdl(collectionId: string): string[] {
  const out: string[] = [];
  specsFor(collectionId).forEach((ix, i) => {
    const cols = ix.fields
      .filter((f) => !f.arrayConfig && f.fieldPath !== '__name__')
      .map((f) => `${fieldExpr(f.fieldPath.split('.'))}${f.order === 'DESCENDING' ? ' DESC' : ''}`);
    if (!cols.length) return;
    if (ix.queryScope !== 'COLLECTION_GROUP') cols.unshift('parent');
    out.push(
      `CREATE INDEX IF NOT EXISTS "ix_${collectionId}_${i}" ON ${tableName(collectionId)} (${cols.join(', ')})`,
    );
  });
  return out;
}

// ─── shards ──────────────────────────────────────────────────────────────────

export interface Row {
  parent: string;
  id: string;
  doc: string;
  v: number;
  ct: number;
  ut: number;
}

export class Shard {
  private readonly stmts = new Map<string, StatementSync>();
  private readonly tables = new Set<string>();
  /** BEGIN IMMEDIATE depth (commit() nests nothing, but be safe). */
  inTx = false;

  constructor(
    readonly key: string,
    readonly conn: DatabaseSync,
  ) {
    conn.exec('PRAGMA busy_timeout = 10000');
    conn.exec('PRAGMA journal_mode = WAL');
    conn.exec('PRAGMA synchronous = NORMAL');
  }

  stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.conn.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Does the collection's table exist (it is created on the first write)? */
  has(collectionId: string): boolean {
    if (this.tables.has(collectionId)) return true;
    const hit = this.stmt(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(
      `c_${collectionId}`,
    );
    if (hit) this.tables.add(collectionId);
    return !!hit;
  }

  ensure(collectionId: string): void {
    if (this.has(collectionId)) return;
    const t = tableName(collectionId);
    this.conn.exec(
      `CREATE TABLE IF NOT EXISTS ${t} (
         parent TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL,
         v INTEGER NOT NULL, ct INTEGER NOT NULL, ut INTEGER NOT NULL,
         PRIMARY KEY (parent, id)) WITHOUT ROWID`,
    );
    for (const ddl of indexDdl(collectionId)) this.conn.exec(ddl);
    this.tables.add(collectionId);
  }

  /** Every collection table in this shard. */
  collections(): string[] {
    return this.stmt(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'c\\_%' ESCAPE '\\'`,
    )
      .all()
      .map((r) => String(r.name).slice(2));
  }

  read(collectionId: string, parent: string, id: string): Row | undefined {
    if (!this.has(collectionId)) return undefined;
    return this.stmt(
      `SELECT parent, id, doc, v, ct, ut FROM ${tableName(collectionId)} WHERE parent = ? AND id = ?`,
    ).get(parent, id) as Row | undefined;
  }

  version(collectionId: string, parent: string, id: string): number {
    if (!this.has(collectionId)) return 0;
    const r = this.stmt(`SELECT v FROM ${tableName(collectionId)} WHERE parent = ? AND id = ?`).get(
      parent,
      id,
    );
    return r ? Number(r.v) : 0;
  }

  upsert(collectionId: string, row: Row): void {
    this.ensure(collectionId);
    this.stmt(
      `INSERT INTO ${tableName(collectionId)} (parent, id, doc, v, ct, ut) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (parent, id) DO UPDATE SET doc = excluded.doc, v = excluded.v, ut = excluded.ut`,
    ).run(row.parent, row.id, row.doc, row.v, row.ct, row.ut);
  }

  remove(collectionId: string, parent: string, id: string): void {
    if (!this.has(collectionId)) return;
    this.stmt(`DELETE FROM ${tableName(collectionId)} WHERE parent = ? AND id = ?`).run(parent, id);
  }

  close(): void {
    this.stmts.clear();
    this.conn.close();
  }
}

// ─── the store: every shard of one directory ────────────────────────────────

export class Store {
  private readonly shards = new Map<string, Shard>();
  readonly memory: boolean;

  constructor(readonly dir: string) {
    this.memory = dir === ':memory:';
    if (!this.memory) mkdirSync(dir, { recursive: true });
  }

  private file(key: string): string {
    return key === ROOT ? join(this.dir, 'root.sqlite') : join(this.dir, `${key}.sqlite`);
  }

  /** The shard for a key; opened (and created) on demand. */
  shard(key: string): Shard {
    let s = this.shards.get(key);
    if (!s) {
      const Db = sqlite();
      if (this.memory) s = new Shard(key, new Db(':memory:'));
      else {
        const file = this.file(key);
        mkdirSync(join(file, '..'), { recursive: true });
        s = new Shard(key, new Db(file));
      }
      this.shards.set(key, s);
    }
    return s;
  }

  /** The shard if it exists, without creating it. */
  existing(key: string): Shard | undefined {
    const open = this.shards.get(key);
    if (open || this.memory) return open;
    if (key === ROOT) return this.shard(ROOT);
    return existsSync(this.file(key)) ? this.shard(key) : undefined;
  }

  /** Every shard that exists: root first, then each board / memory / artifact file. */
  all(): Shard[] {
    const keys = new Set<string>([ROOT, ...this.shards.keys()]);
    if (!this.memory) {
      for (const kind of SHARD_KINDS) {
        let names: string[];
        try {
          names = readdirSync(join(this.dir, kind));
        } catch {
          continue;
        }
        for (const n of names)
          if (n.endsWith('.sqlite')) keys.add(`${kind}/${n.slice(0, -'.sqlite'.length)}`);
      }
    }
    return [...keys].map((k) => this.shard(k));
  }

  /** Drop a whole shard (a board / memory / artifact subtree). */
  drop(key: string): void {
    if (key === ROOT) throw new Error('The root shard is never dropped');
    const s = this.shards.get(key);
    if (s) {
      s.close();
      this.shards.delete(key);
    }
    if (!this.memory) {
      const file = this.file(key);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    }
  }

  /** Wipe everything (tests). */
  wipe(): void {
    for (const key of [...this.shards.keys()]) {
      if (key === ROOT) continue;
      this.drop(key);
    }
    if (!this.memory) {
      for (const kind of SHARD_KINDS)
        rmSync(join(this.dir, kind), { recursive: true, force: true });
    }
    const root = this.shard(ROOT);
    for (const c of root.collections()) root.conn.exec(`DELETE FROM ${tableName(c)}`);
  }

  close(): void {
    for (const s of this.shards.values()) s.close();
    this.shards.clear();
  }
}
