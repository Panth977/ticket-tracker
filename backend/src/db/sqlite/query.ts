/**
 * Firestore queries → SQL over (parent, id, doc) rows.
 *
 * Semantics kept from Firestore:
 *   - a filter or an orderBy on a field excludes documents without it
 *   - '!=' and 'not-in' also exclude null
 *   - a comparison only matches values of the same type (5 is not < 'a')
 *   - without an orderBy, an inequality orders by its field; ties (and
 *     everything else) order by document name, in the last order's direction
 *   - cursors (startAt/After, endAt/Before) compare over that same order,
 *     with values or with a snapshot
 *
 * The common case — scalar values — runs entirely in SQL (filter, order,
 * cursor, offset, limit). A filter on a map / array value or a cursor on a
 * non-scalar runs the rest in JS over the SQL-filtered rows, so the answer
 * is the same either way, only slower. A collection-group query reads each
 * shard and merges in JS.
 */
import { fieldExpr, type Row } from './store.js';
import {
  DbError,
  DOC_ID,
  encode,
  encodedEqual,
  isPlainObject,
  Timestamp,
  type PathLike,
} from './values.js';

export type Op =
  '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';

export interface Filter {
  segs: string[];
  op: Op;
  value: unknown;
}
export interface Order {
  segs: string[];
  dir: 'asc' | 'desc';
}
export interface Cursor {
  /** Either explicit values or a snapshot's (path, encoded doc), resolved at run time. */
  values?: unknown[];
  snapshot?: { path: string; doc: Record<string, unknown> | undefined };
  inclusive: boolean;
}
export interface QueryState {
  collectionId: string;
  /** Parent document path for a collection query ('' at the top); null for a collection group. */
  parent: string | null;
  filters: Filter[];
  orders: Order[];
  limit?: number;
  limitToLast?: number;
  offset?: number;
  start?: Cursor;
  end?: Cursor;
  select?: string[][];
}

const isName = (segs: readonly string[]) => segs.length === 1 && segs[0] === DOC_ID;
const RANGE = new Set<Op>(['<', '<=', '>', '>=', '!=', 'not-in']);

// ─── type order (Firestore's), for JS comparison of ENCODED values ──────────

function typeRank(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (typeof v === 'string') return 5;
  if (Array.isArray(v)) return 9;
  const o = v as Record<string, unknown>;
  const k = Object.keys(o);
  if (k.length === 1) {
    if (k[0] === '__ts') return 3;
    if (k[0] === '__bytes') return 6;
    if (k[0] === '__ref') return 7;
    if (k[0] === '__geo') return 8;
  }
  return 10;
}

export function compareEncoded(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0:
      return 0;
    case 1:
    case 2:
      return Number(a) - Number(b);
    case 3:
      return (a as { __ts: number }).__ts - (b as { __ts: number }).__ts;
    case 5:
      return Buffer.compare(Buffer.from(a as string), Buffer.from(b as string));
    case 6:
      return Buffer.compare(
        Buffer.from((a as { __bytes: string }).__bytes, 'base64'),
        Buffer.from((b as { __bytes: string }).__bytes, 'base64'),
      );
    case 7:
      return compareEncoded((a as { __ref: string }).__ref, (b as { __ref: string }).__ref);
    case 8: {
      const [la, ga] = (a as { __geo: number[] }).__geo;
      const [lb, gb] = (b as { __geo: number[] }).__geo;
      return la! - lb! || ga! - gb!;
    }
    case 9: {
      const aa = a as unknown[];
      const bb = b as unknown[];
      for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
        const c = compareEncoded(aa[i], bb[i]);
        if (c) return c;
      }
      return aa.length - bb.length;
    }
    default: {
      const ka = Object.keys(a as object).sort();
      const kb = Object.keys(b as object).sort();
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        const c =
          compareEncoded(ka[i], kb[i]) ||
          compareEncoded(
            (a as Record<string, unknown>)[ka[i]!],
            (b as Record<string, unknown>)[kb[i]!],
          );
        if (c) return c;
      }
      return ka.length - kb.length;
    }
  }
}

// ─── the compiled plan ───────────────────────────────────────────────────────

export interface LoadedRow extends Row {
  /** Parsed `doc`. */
  data: Record<string, unknown>;
  path: string;
}

function getAt(doc: unknown, segs: readonly string[]): unknown {
  let cur = doc;
  for (const s of segs) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

/** The value a row sorts / filters by on `segs` (the name is the path for a group, else the id). */
function valueOf(row: LoadedRow, segs: readonly string[], group: boolean): unknown {
  if (isName(segs)) return group ? row.path : row.id;
  return getAt(row.data, segs);
}

type IsRef = (v: unknown) => v is PathLike;

export class Plan {
  readonly group: boolean;
  readonly orders: Order[];
  private readonly encodedFilters: { f: Filter; v: unknown }[];
  /** Everything runs in SQL (no JS filter / cursor / paging needed). */
  readonly pureSql: boolean;

  constructor(
    readonly q: QueryState,
    private readonly isRef: IsRef,
    /** Rows are already in memory (src/db/drive): filter, sort and page in JS. */
    inMemory = false,
  ) {
    this.group = q.parent === null;
    // Firestore: an inequality field orders first when no explicit order is given;
    // the document name always breaks ties, in the last order's direction.
    const orders = [...q.orders];
    if (!orders.length) {
      for (const f of q.filters)
        if (RANGE.has(f.op) && !orders.some((o) => o.segs.join('.') === f.segs.join('.')))
          orders.push({ segs: f.segs, dir: 'asc' });
    }
    if (!orders.some((o) => isName(o.segs)))
      orders.push({ segs: [DOC_ID], dir: orders.length ? orders[orders.length - 1]!.dir : 'asc' });
    this.orders = orders;
    this.encodedFilters = q.filters.map((f) => ({ f, v: this.encodeFilterValue(f) }));
    this.pureSql =
      !inMemory &&
      this.encodedFilters.every(({ f, v }) => this.sqlFilterable(f, v)) &&
      [q.start, q.end].every((c) => !c || this.sqlCursor(c)) &&
      q.limitToLast === undefined;
  }

  private encodeFilterValue(f: Filter): unknown {
    if (isName(f.segs)) {
      const norm = (x: unknown) => {
        const path = this.isRef(x) ? x.path : String(x);
        if (this.group) {
          if (!path.includes('/'))
            throw new DbError(
              'INVALID_ARGUMENT',
              `When querying a collection group and ordering by FieldPath.documentId(), the corresponding value must result in a valid document path, but '${path}' is not because it contains an odd number of segments.`,
            );
          return path;
        }
        return path.includes('/') ? path.split('/').pop()! : path;
      };
      return f.op === 'in' || f.op === 'not-in' ? (f.value as unknown[]).map(norm) : norm(f.value);
    }
    if (f.op === 'in' || f.op === 'not-in' || f.op === 'array-contains-any') {
      if (!Array.isArray(f.value))
        throw new DbError(
          'INVALID_ARGUMENT',
          `Invalid Query. A non-empty array is required for '${f.op}' filters.`,
        );
      return f.value.map((x) => encode(x, this.isRef));
    }
    return encode(f.value, this.isRef);
  }

  /** A scalar SQLite can bind and compare with type-correct results. */
  private static scalar(v: unknown): boolean {
    return (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      v === null ||
      (isPlainObject(v) && Object.keys(v).length === 1 && typeof v.__ts === 'number')
    );
  }

  private sqlFilterable(f: Filter, v: unknown): boolean {
    if (Array.isArray(v) && (f.op === 'in' || f.op === 'not-in' || f.op === 'array-contains-any'))
      return v.every((x) => Plan.scalar(x) && x !== null);
    return Plan.scalar(v);
  }

  private cursorValues(c: Cursor): unknown[] {
    if (c.values) return c.values;
    const snap = c.snapshot!;
    if (!snap.doc)
      throw new DbError(
        'INVALID_ARGUMENT',
        `Can't use a DocumentSnapshot for a document that doesn't exist (${snap.path}).`,
      );
    return this.orders.map((o) =>
      isName(o.segs)
        ? this.group
          ? snap.path
          : snap.path.split('/').pop()!
        : getAt(snap.doc, o.segs),
    );
  }

  private encodedCursor(c: Cursor): unknown[] {
    const vals = this.cursorValues(c);
    if (vals.length > this.orders.length)
      throw new DbError(
        'INVALID_ARGUMENT',
        'Too many cursor values specified. The specified values must match the orderBy() constraints of the query.',
      );
    return vals.map((x, i) => {
      if (isName(this.orders[i]!.segs)) {
        const path = this.isRef(x) ? x.path : String(x);
        return this.group ? path : path.split('/').pop()!;
      }
      return c.snapshot ? x : encode(x, this.isRef);
    });
  }

  private sqlCursor(c: Cursor): boolean {
    try {
      return this.encodedCursor(c).every(
        (x) => Plan.scalar(x) && x !== null && typeof x !== 'boolean',
      );
    } catch {
      return false;
    }
  }

  // ─── SQL ───────────────────────────────────────────────────────────────────

  private nameExpr(): string {
    return this.group ? `(parent || '/' || id)` : 'id';
  }

  private expr(segs: readonly string[], v?: unknown): string {
    if (isName(segs)) return this.nameExpr();
    if (isPlainObject(v) && typeof v.__ts === 'number') return fieldExpr([...segs, '__ts']);
    return fieldExpr(segs);
  }
  private typeExpr(segs: readonly string[]): string {
    return fieldExpr(segs).replace(/^json_extract/, 'json_type');
  }

  /** Bind value + a type guard so a comparison only matches its own type. */
  private typed(
    segs: readonly string[],
    v: unknown,
    params: unknown[],
  ): { e: string; guard: string; p: string } {
    if (isName(segs)) {
      params.push(v);
      return { e: this.nameExpr(), guard: '', p: '?' };
    }
    const t = this.typeExpr(segs);
    if (isPlainObject(v) && typeof v.__ts === 'number') {
      params.push(v.__ts);
      return { e: this.expr(segs, v), guard: `${t} = 'object'`, p: '?' };
    }
    if (typeof v === 'number') {
      params.push(v);
      return { e: this.expr(segs), guard: `${t} IN ('integer','real')`, p: '?' };
    }
    if (typeof v === 'string') {
      params.push(v);
      return { e: this.expr(segs), guard: `${t} = 'text'`, p: '?' };
    }
    if (typeof v === 'boolean') {
      return { e: '', guard: `${t} = '${v ? 'true' : 'false'}'`, p: '' };
    }
    return { e: '', guard: `${t} = 'null'`, p: '' }; // null
  }

  private filterSql(f: Filter, v: unknown, params: unknown[]): string | null {
    if (!this.sqlFilterable(f, v)) {
      // JS evaluates it; SQL only keeps "field present" to narrow the rows.
      return isName(f.segs) ? null : `${this.typeExpr(f.segs)} IS NOT NULL`;
    }
    const segs = f.segs;
    const present = isName(segs) ? '' : `${this.typeExpr(segs)} IS NOT NULL`;
    const notNull = isName(segs) ? '' : `${this.typeExpr(segs)} != 'null'`;
    const and = (...xs: string[]) => xs.filter(Boolean).join(' AND ');
    switch (f.op) {
      case '==': {
        const t = this.typed(segs, v, params);
        return and(t.guard, t.e ? `${t.e} = ${t.p}` : '');
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (v === null || typeof v === 'boolean') {
          // Only equal-typed values compare; for null/bool that is equality-ish.
          if (v === null)
            return f.op === '<=' || f.op === '>=' ? `${this.typeExpr(segs)} = 'null'` : '0';
          const lo = v === false;
          const t = this.typeExpr(segs);
          if (f.op === '<') return lo ? '0' : `${t} = 'false'`;
          if (f.op === '>') return lo ? `${t} = 'true'` : '0';
          if (f.op === '<=') return lo ? `${t} = 'false'` : `${t} IN ('true','false')`;
          return lo ? `${t} IN ('true','false')` : `${t} = 'true'`;
        }
        const t = this.typed(segs, v, params);
        return and(t.guard, `${t.e} ${f.op} ${t.p}`);
      }
      case '!=': {
        if (v === null) return and(present, notNull);
        if (typeof v === 'boolean')
          return and(present, notNull, `${this.typeExpr(segs)} != '${v ? 'true' : 'false'}'`);
        const t = this.typed(segs, v, params);
        // Different type → not equal → matches.
        return and(present, notNull, `NOT (${t.guard ? `${t.guard} AND ` : ''}${t.e} = ${t.p})`);
      }
      case 'in':
      case 'not-in': {
        const vals = v as unknown[];
        if (!vals.length)
          throw new DbError(
            'INVALID_ARGUMENT',
            `Invalid Query. A non-empty array is required for '${f.op}' filters.`,
          );
        const parts = vals.map((x) => {
          const t = this.typed(segs, x, params);
          return `(${and(t.guard, t.e ? `${t.e} = ${t.p}` : '')})`;
        });
        const any = `(${parts.join(' OR ')})`;
        return f.op === 'in' ? any : and(present, notNull, `NOT ${any}`);
      }
      case 'array-contains':
      case 'array-contains-any': {
        const vals = f.op === 'array-contains' ? [v] : (v as unknown[]);
        const path = fieldExpr(segs).match(/'(.*)'\)$/)![1]!;
        const conds = vals.map((x) => {
          if (x === null) return `je.type = 'null'`;
          if (typeof x === 'boolean') return `je.type = '${x ? 'true' : 'false'}'`;
          if (isPlainObject(x)) {
            params.push(x.__ts as number);
            return `(je.type = 'object' AND json_extract(je.value, '$.__ts') = ?)`;
          }
          params.push(x);
          return typeof x === 'number'
            ? `(je.type IN ('integer','real') AND je.value = ?)`
            : `(je.type = 'text' AND je.value = ?)`;
        });
        return `${this.typeExpr(segs)} = 'array' AND EXISTS (SELECT 1 FROM json_each(doc, '${path}') AS je WHERE ${conds.join(' OR ')})`;
      }
    }
  }

  private cursorSql(c: Cursor, isStart: boolean, params: unknown[]): string {
    const vals = this.encodedCursor(c);
    const ors: string[] = [];
    for (let i = 0; i < vals.length; i++) {
      const eqs: string[] = [];
      for (let j = 0; j < i; j++) {
        const t = this.typed(this.orders[j]!.segs, vals[j], params);
        eqs.push(`${t.e} = ${t.p}`);
      }
      const o = this.orders[i]!;
      const forward = isStart === (o.dir === 'asc');
      const t = this.typed(o.segs, vals[i], params);
      eqs.push(`${t.e} ${forward ? '>' : '<'} ${t.p}`);
      ors.push(`(${eqs.join(' AND ')})`);
    }
    if (c.inclusive) {
      const eqs: string[] = [];
      for (let j = 0; j < vals.length; j++) {
        const t = this.typed(this.orders[j]!.segs, vals[j], params);
        eqs.push(`${t.e} = ${t.p}`);
      }
      ors.push(`(${eqs.join(' AND ')})`);
    }
    return `(${ors.join(' OR ')})`;
  }

  /** SELECT for one shard. `count` returns COUNT(*) instead of rows. */
  sql(
    table: string,
    opts: { count?: boolean; paged: boolean },
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const where: string[] = [];
    if (!this.group) {
      where.push('parent = ?');
      params.push(this.q.parent);
    }
    for (const { f, v } of this.encodedFilters) {
      const s = this.filterSql(f, v, params);
      if (s) where.push(`(${s})`);
    }
    for (const o of this.orders)
      if (!isName(o.segs)) where.push(`${this.typeExpr(o.segs)} IS NOT NULL`);
    if (this.pureSql) {
      if (this.q.start) where.push(this.cursorSql(this.q.start, true, params));
      if (this.q.end) where.push(this.cursorSql(this.q.end, false, params));
    }
    const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const order = this.orders
      .map((o) =>
        isName(o.segs)
          ? this.group
            ? `parent ${o.dir}, id ${o.dir}`
            : `id ${o.dir}`
          : `${this.expr(o.segs)} ${o.dir}`,
      )
      .join(', ');
    let tail = '';
    if (opts.paged && this.pureSql && (this.q.limit !== undefined || this.q.offset)) {
      tail = ` LIMIT ${this.q.limit ?? -1}${this.q.offset ? ` OFFSET ${this.q.offset}` : ''}`;
    } else if (!opts.paged && this.pureSql && this.q.limit !== undefined) {
      // A group query across shards: each shard returns at most offset+limit.
      tail = ` LIMIT ${this.q.limit + (this.q.offset ?? 0)}`;
    }
    if (opts.count) {
      if (this.q.limit !== undefined || this.q.offset)
        return {
          sql: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table}${w} ORDER BY ${order}${tail})`,
          params,
        };
      return { sql: `SELECT COUNT(*) AS n FROM ${table}${w}`, params };
    }
    return {
      sql: `SELECT parent, id, doc, v, ct, ut FROM ${table}${w} ORDER BY ${order}${tail}`,
      params,
    };
  }

  // ─── JS (exact semantics; used for what SQL does not do) ──────────────────

  private matchesFilter(row: LoadedRow, f: Filter, v: unknown): boolean {
    const x = valueOf(row, f.segs, this.group);
    if (x === undefined) return false;
    const same = (a: unknown, b: unknown) => typeRank(a) === typeRank(b);
    switch (f.op) {
      case '==':
        return encodedEqual(x, v);
      case '!=':
        return x !== null && !encodedEqual(x, v);
      case '<':
        return same(x, v) && compareEncoded(x, v) < 0;
      case '<=':
        return same(x, v) && compareEncoded(x, v) <= 0;
      case '>':
        return same(x, v) && compareEncoded(x, v) > 0;
      case '>=':
        return same(x, v) && compareEncoded(x, v) >= 0;
      case 'in':
        return (v as unknown[]).some((y) => encodedEqual(x, y));
      case 'not-in':
        return x !== null && !(v as unknown[]).some((y) => encodedEqual(x, y));
      case 'array-contains':
        return Array.isArray(x) && x.some((y) => encodedEqual(y, v));
      case 'array-contains-any':
        return Array.isArray(x) && x.some((y) => (v as unknown[]).some((z) => encodedEqual(y, z)));
    }
  }

  compareRows = (a: LoadedRow, b: LoadedRow): number => {
    for (const o of this.orders) {
      const c = compareEncoded(valueOf(a, o.segs, this.group), valueOf(b, o.segs, this.group));
      if (c) return o.dir === 'asc' ? c : -c;
    }
    return 0;
  };

  private cursorCompare(row: LoadedRow, vals: unknown[]): number {
    for (let i = 0; i < vals.length; i++) {
      const o = this.orders[i]!;
      const c = compareEncoded(valueOf(row, o.segs, this.group), vals[i]);
      if (c) return o.dir === 'asc' ? c : -c;
    }
    return 0;
  }

  /** Finish in JS: filters SQL skipped, sort (multi-shard), cursors, offset, limit. */
  finish(rows: LoadedRow[], sorted: boolean): LoadedRow[] {
    let out = rows;
    if (!this.pureSql) {
      out = out.filter((r) => this.encodedFilters.every(({ f, v }) => this.matchesFilter(r, f, v)));
      out = out.filter((r) =>
        this.orders.every((o) => isName(o.segs) || getAt(r.data, o.segs) !== undefined),
      );
    }
    if (!sorted || !this.pureSql) out = [...out].sort(this.compareRows);
    if (!this.pureSql) {
      if (this.q.start) {
        const vals = this.encodedCursor(this.q.start);
        out = out.filter((r) => {
          const c = this.cursorCompare(r, vals);
          return this.q.start!.inclusive ? c >= 0 : c > 0;
        });
      }
      if (this.q.end) {
        const vals = this.encodedCursor(this.q.end);
        out = out.filter((r) => {
          const c = this.cursorCompare(r, vals);
          return this.q.end!.inclusive ? c <= 0 : c < 0;
        });
      }
    }
    if (!this.pureSql || !sorted) {
      if (this.q.offset) out = out.slice(this.q.offset);
      if (this.q.limit !== undefined) out = out.slice(0, this.q.limit);
      if (this.q.limitToLast !== undefined)
        out = out.slice(Math.max(0, out.length - this.q.limitToLast));
    }
    return out;
  }
}

export { Timestamp };
