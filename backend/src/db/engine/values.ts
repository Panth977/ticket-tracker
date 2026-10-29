/**
 * The value classes of the SQLite adapter — same API as the Admin SDK's, and
 * the JSON codec that stores them inside a document.
 *
 * Stored forms (a key starting with "__" is reserved for these):
 *   Timestamp          { "__ts": <epoch ms, fractional for sub-ms> }
 *   GeoPoint           { "__geo": [lat, lng] }
 *   DocumentReference  { "__ref": "<path>" }
 *   bytes              { "__bytes": "<base64>" }
 */
import type {
  FieldPath as FieldPathT,
  FieldValue as FieldValueT,
  GeoPoint as GeoPointT,
  Timestamp as TimestampT,
} from '../types.js';

// ─── errors (gRPC codes, as the Firestore SDK raises them) ──────────────────

export const CODES = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
} as const;
type CodeName = keyof typeof CODES;

export class DbError extends Error {
  readonly code: number;
  readonly details: string;
  constructor(code: CodeName, details: string) {
    super(`${CODES[code]} ${code}: ${details}`);
    this.name = 'DbError';
    this.code = CODES[code];
    this.details = details;
  }
}

// ─── Timestamp ───────────────────────────────────────────────────────────────

export class Timestamp implements TimestampT {
  readonly seconds: number;
  readonly nanoseconds: number;
  constructor(seconds: number, nanoseconds: number) {
    if (
      !Number.isFinite(seconds) ||
      !Number.isInteger(nanoseconds) ||
      nanoseconds < 0 ||
      nanoseconds >= 1e9
    )
      throw new DbError('INVALID_ARGUMENT', `Invalid timestamp (${seconds}, ${nanoseconds})`);
    this.seconds = Math.floor(seconds);
    this.nanoseconds = nanoseconds;
  }
  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  static fromDate(date: Date): Timestamp {
    return Timestamp.fromMillis(date.getTime());
  }
  static fromMillis(ms: number): Timestamp {
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = Math.round((ms - seconds * 1000) * 1e6);
    return nanoseconds >= 1e9 ? new Timestamp(seconds + 1, 0) : new Timestamp(seconds, nanoseconds);
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  toMillis(): number {
    return this.seconds * 1000 + this.nanoseconds / 1e6;
  }
  isEqual(other: TimestampT): boolean {
    return other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
  /** Sortable string, as the SDK's: comparisons with < and > work. */
  valueOf(): string {
    const s = String(this.seconds + 1e12).padStart(13, '0');
    return `${s}.${String(this.nanoseconds).padStart(9, '0')}`;
  }
  toJSON(): { _seconds: number; _nanoseconds: number } {
    return { _seconds: this.seconds, _nanoseconds: this.nanoseconds };
  }
}

// ─── FieldValue ──────────────────────────────────────────────────────────────

export type FieldValueKind =
  'increment' | 'arrayUnion' | 'arrayRemove' | 'delete' | 'serverTimestamp';

export class FieldValue implements FieldValueT {
  /** @internal */
  constructor(
    readonly kind: FieldValueKind,
    readonly operand?: unknown,
  ) {}
  static increment(n: number): FieldValue {
    return new FieldValue('increment', n);
  }
  static arrayUnion(...elements: unknown[]): FieldValue {
    return new FieldValue('arrayUnion', elements);
  }
  static arrayRemove(...elements: unknown[]): FieldValue {
    return new FieldValue('arrayRemove', elements);
  }
  static delete(): FieldValue {
    return new FieldValue('delete');
  }
  static serverTimestamp(): FieldValue {
    return new FieldValue('serverTimestamp');
  }
  isEqual(other: FieldValueT): boolean {
    return (
      other instanceof FieldValue &&
      other.kind === this.kind &&
      JSON.stringify(other.operand) === JSON.stringify(this.operand)
    );
  }
}

// ─── FieldPath ───────────────────────────────────────────────────────────────

export const DOC_ID = '__name__';

export class FieldPath implements FieldPathT {
  readonly segments: readonly string[];
  constructor(...segments: string[]) {
    if (segments.length === 0 || segments.some((s) => typeof s !== 'string' || s === ''))
      throw new DbError('INVALID_ARGUMENT', 'Element at index 0 should not be an empty string.');
    this.segments = segments;
  }
  static documentId(): FieldPath {
    return new FieldPath(DOC_ID);
  }
  isEqual(other: FieldPathT): boolean {
    return (
      other instanceof FieldPath && other.segments.join('\u0000') === this.segments.join('\u0000')
    );
  }
  get isDocumentId(): boolean {
    return this.segments.length === 1 && this.segments[0] === DOC_ID;
  }
}

/** 'a.b.c' or a FieldPath → segments. */
export function segmentsOf(field: string | FieldPathT): string[] {
  if (field instanceof FieldPath) return [...field.segments];
  if (
    typeof field !== 'string' ||
    field === '' ||
    field.startsWith('.') ||
    field.endsWith('.') ||
    field.includes('..')
  )
    throw new DbError(
      'INVALID_ARGUMENT',
      `Invalid field path: ${JSON.stringify(field)}. Paths must not be empty, begin with '.', end with '.', or contain '..'`,
    );
  return field.split('.');
}

// ─── GeoPoint ────────────────────────────────────────────────────────────────

export class GeoPoint implements GeoPointT {
  constructor(
    readonly latitude: number,
    readonly longitude: number,
  ) {}
  isEqual(other: GeoPointT): boolean {
    return other.latitude === this.latitude && other.longitude === this.longitude;
  }
}

// ─── codec ───────────────────────────────────────────────────────────────────

/** Anything with a `path` that the adapter's refs produce. */
export interface PathLike {
  readonly path: string;
}
export type RefFactory = (path: string) => unknown;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * A resolved value (no sentinels left) → its JSON form. `undefined`
 * properties are dropped (the Firestore adapter runs with
 * ignoreUndefinedProperties, so the code relies on that).
 */
export function encode(v: unknown, isRef: (v: unknown) => v is PathLike): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new DbError('INVALID_ARGUMENT', `Cannot encode number ${v}`);
    return v;
  }
  if (v === undefined) return null;
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (v instanceof GeoPoint) return { __geo: [v.latitude, v.longitude] };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array)
    return { __bytes: Buffer.from(v).toString('base64') };
  if (isRef(v)) return { __ref: v.path };
  if (Array.isArray(v)) return v.map((x) => encode(x, isRef));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      out[k] = encode(x, isRef);
    }
    return out;
  }
  if (v instanceof FieldValue)
    throw new DbError('INVALID_ARGUMENT', `FieldValue.${v.kind}() cannot be used here`);
  throw new DbError(
    'INVALID_ARGUMENT',
    `Couldn't serialize object of type "${(v as object).constructor?.name ?? typeof v}". Input is not a plain JavaScript object.`,
  );
}

/** JSON form → values (Timestamp, GeoPoint, refs, Buffer). */
export function decode(v: unknown, ref: RefFactory): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => decode(x, ref));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const k = keys[0]!;
    if (k === '__ts' && typeof o.__ts === 'number') return Timestamp.fromMillis(o.__ts);
    if (k === '__geo' && Array.isArray(o.__geo))
      return new GeoPoint(o.__geo[0] as number, o.__geo[1] as number);
    if (k === '__ref' && typeof o.__ref === 'string') return ref(o.__ref);
    if (k === '__bytes' && typeof o.__bytes === 'string') return Buffer.from(o.__bytes, 'base64');
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decode(o[k], ref);
  return out;
}

/** Deep equality of two ENCODED values (arrayUnion / arrayRemove / '==' on maps). */
export function encodedEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => encodedEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    encodedEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

// ─── size (Firestore's formula, so the 1 MiB limit bites at the same place) ─

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

export function encodedSize(v: unknown): number {
  if (v === null || typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'string') return utf8(v) + 1;
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + encodedSize(x), 0);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    if (keys[0] === '__ts') return 8;
    if (keys[0] === '__geo') return 16;
    if (keys[0] === '__ref' && typeof o.__ref === 'string') return utf8(o.__ref) + 1;
    if (keys[0] === '__bytes' && typeof o.__bytes === 'string')
      return Math.ceil((o.__bytes.length * 3) / 4);
  }
  return keys.reduce((n, k) => n + utf8(k) + 1 + encodedSize(o[k]), 0);
}

export const MAX_DOC_BYTES = 1_048_576;

export function documentSize(path: string, doc: Record<string, unknown>): number {
  const name = path.split('/').reduce((n, s) => n + utf8(s) + 1, 16);
  return name + 32 + encodedSize(doc);
}
