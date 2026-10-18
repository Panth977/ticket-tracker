/**
 * Values across the bridge between the ACTIVE adapter (usually the Admin SDK)
 * and the JSON a Drive ticket file holds.
 *
 * The Drive store reuses the SQLite adapter's pure machinery — the JSON codec
 * (values.ts), Firestore's write semantics (mutate.ts) and its query
 * semantics (query.ts) — which speak the SQLite value classes. Code above the
 * port hands in the active adapter's classes (FieldValue.increment(1) from the
 * Admin SDK on Firebase), so they are translated on the way in, and decoded
 * Timestamps translated back on the way out.
 */
import {
  FieldPath as SqlFieldPath,
  FieldValue as SqlFieldValue,
  Timestamp as SqlTimestamp,
  decode,
  encode,
  isPlainObject,
  type FieldValueKind,
  type PathLike,
} from '../sqlite/values.js';
import type { TimestampStatic } from '../types.js';

type Json = Record<string, unknown>;

/** The Admin SDK's sentinel names → the SQLite adapter's kinds. */
const ADMIN_KINDS: Record<string, FieldValueKind> = {
  'FieldValue.delete': 'delete',
  'FieldValue.serverTimestamp': 'serverTimestamp',
  'FieldValue.increment': 'increment',
  'FieldValue.arrayUnion': 'arrayUnion',
  'FieldValue.arrayRemove': 'arrayRemove',
};

interface ForeignSentinel {
  methodName: string;
  operand?: unknown;
  elements?: unknown[];
}
const isForeignSentinel = (v: unknown): v is ForeignSentinel =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { methodName?: unknown }).methodName === 'string' &&
  (v as ForeignSentinel).methodName in ADMIN_KINDS;

const isForeignTimestamp = (v: unknown): v is { seconds: number; nanoseconds: number } =>
  typeof v === 'object' &&
  v !== null &&
  !(v instanceof SqlTimestamp) &&
  typeof (v as { toMillis?: unknown }).toMillis === 'function' &&
  typeof (v as { seconds?: unknown }).seconds === 'number' &&
  typeof (v as { nanoseconds?: unknown }).nanoseconds === 'number';

/** A FieldPath of any adapter → its segments (null when it is not one). */
export function foreignSegments(v: unknown): string[] | null {
  if (v instanceof SqlFieldPath) return [...v.segments];
  if (
    typeof v !== 'object' ||
    v === null ||
    typeof (v as { isEqual?: unknown }).isEqual !== 'function'
  )
    return null;
  const segs = (v as { segments?: unknown; _segments?: unknown }).segments;
  return Array.isArray(segs) && segs.every((s) => typeof s === 'string') ? [...segs] : null;
}

/** Anything coming from code above the port → the SQLite value classes. */
export function toLocal(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof SqlFieldValue || v instanceof SqlTimestamp || v instanceof SqlFieldPath)
    return v;
  if (isForeignSentinel(v)) {
    const kind = ADMIN_KINDS[v.methodName]!;
    if (kind === 'increment') return new SqlFieldValue(kind, v.operand);
    if (kind === 'arrayUnion' || kind === 'arrayRemove')
      return new SqlFieldValue(kind, (v.elements ?? []).map(toLocal));
    return new SqlFieldValue(kind);
  }
  if (isForeignTimestamp(v)) return new SqlTimestamp(v.seconds, v.nanoseconds);
  const segs = foreignSegments(v);
  if (segs) return new SqlFieldPath(...segs);
  if (v instanceof Date || Buffer.isBuffer(v) || v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(toLocal);
  if (isPlainObject(v)) {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = toLocal(x);
    return out;
  }
  return v;
}

/** SQLite-class values (decoded) → the active adapter's Timestamp. */
export function toActive(v: unknown, Ts: TimestampStatic): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof SqlTimestamp) return new Ts(v.seconds, v.nanoseconds);
  if (Array.isArray(v)) return v.map((x) => toActive(x, Ts));
  if (isPlainObject(v)) {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = toActive(x, Ts);
    return out;
  }
  return v;
}

const isPathLike = (v: unknown): v is PathLike =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { path?: unknown }).path === 'string' &&
  typeof (v as { collection?: unknown }).collection === 'function';

/** A resolved local value → JSON (what a Drive file holds). */
export const encodeJson = (v: unknown): unknown => encode(toLocal(v), isPathLike);
export const isRefValue = isPathLike;

/** JSON → values of the active adapter. References come back as plain paths. */
export function decodeJson(v: unknown, Ts: TimestampStatic): unknown {
  return toActive(
    decode(v, (p) => ({ path: p })),
    Ts,
  );
}
