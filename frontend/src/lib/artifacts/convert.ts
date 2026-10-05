/**
 * VALUES ACROSS THE FENCE (docs/plan/artifacts.html §E2). What an artifact
 * sends is a structured clone from code we did not write; what we send back
 * must survive a structured clone. Both directions go through here.
 *
 *   in   Date → the store's timestamp · SERVER_TIME → the store's server
 *        timestamp · plain objects / arrays / primitives as they are ·
 *        ANYTHING ELSE (Map, Blob, a typed array, a class instance) refused
 *   out  the store's timestamp → Date · plain data as it is · anything else
 *        (a DocumentReference, a GeoPoint — not in v1) → null
 *
 * Pure on purpose: the store-specific bits (Firestore's Timestamp, RTDB's
 * serverTimestamp) are handed in, so this is tested without Firebase.
 */
import { isServerTime } from '@tm/shared';

/** Thrown for a value the artifact may not write; the broker answers invalid-argument. */
export class ValueError extends Error {
  readonly code = 'invalid-argument';
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Firestore's own nesting limit; also what stops a cyclic clone. */
export const MAX_DEPTH = 20;

export interface WriteCodec {
  date(d: Date): unknown;
  serverTime(): unknown;
  /** Called for every object key; throw ValueError to refuse it (RTDB's key rules). */
  key?(k: string): void;
  /** RTDB cannot hold NaN / Infinity; Firestore can. */
  finiteOnly?: boolean;
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** An artifact's value → what the store is given. */
export function toStored(value: unknown, codec: WriteCodec, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new ValueError(`A value may nest at most ${MAX_DEPTH} levels`);
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (codec.finiteOnly && !Number.isFinite(value))
        throw new ValueError('NaN and Infinity cannot be stored here');
      return value;
    case 'undefined':
      throw new ValueError('undefined cannot be stored (use null, or leave the key out)');
    case 'object':
      break;
    default:
      throw new ValueError(`A ${typeof value} cannot be stored`);
  }
  if (isServerTime(value)) return codec.serverTime();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ValueError('An invalid Date cannot be stored');
    return codec.date(value);
  }
  if (Array.isArray(value)) return value.map((v) => toStored(v, codec, depth + 1));
  if (!isPlainObject(value))
    throw new ValueError(
      'Only plain objects, arrays, strings, numbers, booleans, null and Date can be stored',
    );
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // A key set to undefined is "not there" — what JSON and most callers mean.
    if (v === undefined) continue;
    codec.key?.(k);
    out[k] = toStored(v, codec, depth + 1);
  }
  return out;
}

/** toStored for something that must be an object at the top (a document, a patch). */
export function toStoredObject(
  value: unknown,
  codec: WriteCodec,
  what: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValueError(`${what} must be an object`);
  return toStored(value, codec) as Record<string, unknown>;
}

/** A stored value → what the artifact is sent. `asDate` recognises the store's timestamp. */
export function fromStored(
  value: unknown,
  asDate: (v: unknown) => Date | null,
  depth = 0,
): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object')
    return typeof value === 'function' || typeof value === 'symbol' ? null : value;
  if (depth > MAX_DEPTH + 2) return null;
  const d = asDate(value);
  if (d) return d;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => fromStored(v, asDate, depth + 1));
  // References, GeoPoints, Bytes: not in v1, and their instances hold things
  // (the Firestore client) that must never be cloned into an artifact.
  if (!isPlainObject(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = fromStored(v, asDate, depth + 1);
  return out;
}
