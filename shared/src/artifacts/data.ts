/**
 * THE ARTIFACT'S DATA, FROM OUTSIDE THE PAGE (docs/plan/agents.html §AA4).
 *
 * Until §AA an artifact's database could only be written from inside the
 * page, by whoever was looking at it (the driver, ./driver.ts). These are the
 * shapes of the same fence (./paths.ts) reached with a TOKEN: REST
 * /v1/artifacts/{id}/data/… and the MCP artifact_data_* tools. Both doors and
 * the SDK are typed from this file.
 *
 * VALUES ARE JSON, WITH TWO ESCAPES — each an object with exactly one key:
 *
 *   { "$date": "2026-09-30T05:30:00Z" }   a timestamp. BOTH WAYS: written, it
 *                                         is stored as a Firestore Timestamp;
 *                                         a stored timestamp is read back in
 *                                         this form. (The page sees the same
 *                                         value through the driver as a Date.)
 *   { "$serverTime": true }               in a WRITE only: the server's clock.
 *
 * Any other single-key object whose key starts with '$' is refused, so the
 * escape space stays clean for a later escape. A map with several keys may use
 * '$' in them freely.
 *
 * Everything here is pure: no Firebase, no I/O. The backend turns an encoded
 * value into what Firestore stores (backend/src/platform/artifactData.ts).
 */
import { z } from 'zod';
import { LIST_LIMIT_MAX, WHERE_OPS, type WhereOp } from './driver.js';
import { ARTIFACT_PATH_MAX } from './paths.js';

export const DATE_ESCAPE = '$date' as const;
export const SERVER_TIME_ESCAPE = '$serverTime' as const;
/** { "$date": ISO } */
export interface DateEscape {
  $date: string;
}
/** { "$serverTime": true } */
export interface ServerTimeEscape {
  $serverTime: true;
}

/** A plain object (not an array, not null, not a class instance like Date). */
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * The ONE key of a single-key object when it starts with '$' — i.e. "this is
 * (meant as) an escape" — else null. `{ "$date": … }` → '$date'.
 */
export function escapeKeyOf(v: unknown): string | null {
  if (!isPlain(v)) return null;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0]!.startsWith('$') ? keys[0]! : null;
}

export const isDateEscape = (v: unknown): v is DateEscape =>
  escapeKeyOf(v) === DATE_ESCAPE && typeof (v as DateEscape).$date === 'string';
export const isServerTimeEscape = (v: unknown): v is ServerTimeEscape =>
  escapeKeyOf(v) === SERVER_TIME_ESCAPE && (v as ServerTimeEscape).$serverTime === true;

/** A timestamp as it crosses the API. */
export const dateEscape = (at: Date | number): DateEscape => ({
  $date: new Date(at).toISOString(),
});
/** The server's clock, for a write. */
export const SERVER_TIME_JSON: ServerTimeEscape = Object.freeze({
  $serverTime: true,
}) as ServerTimeEscape;

export class ArtifactValueError extends Error {
  readonly code = 'invalid-argument';
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactValueError';
  }
}

/** What the backend supplies to turn the two escapes into stored values. */
export interface ValueDecoder<T> {
  /** A parsed `$date` (always a valid instant). */
  date(at: Date): T;
  /** `$serverTime`. Called only where the store allows it (not inside an array). */
  serverTime(): T;
}

/**
 * JSON from outside → the value to store. Walks maps and arrays; swaps the
 * two escapes through `dec`; refuses every other '$'-prefixed single-key
 * object, an unparseable `$date`, a `$serverTime` that is not `true` or that
 * sits inside an array (Firestore cannot stamp inside one), and values JSON
 * cannot carry anyway (undefined, functions, non-finite numbers). Throws
 * ArtifactValueError naming where, e.g. "items[2].at".
 */
function decodeAt<T>(v: unknown, where: string, inArray: boolean, dec: ValueDecoder<T>): unknown {
  const at = where || 'value';
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ArtifactValueError(`${at}: not a finite number`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => decodeAt(x, `${where}[${i}]`, true, dec));
  if (!isPlain(v)) throw new ArtifactValueError(`${at}: not a JSON value`);
  const esc = escapeKeyOf(v);
  if (esc === DATE_ESCAPE) {
    const raw = v[DATE_ESCAPE];
    const when = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
    if (Number.isNaN(when.getTime()))
      throw new ArtifactValueError(
        `${at}: "$date" takes an ISO 8601 string, e.g. { "$date": "2026-09-30T05:30:00Z" }`,
      );
    return dec.date(when);
  }
  if (esc === SERVER_TIME_ESCAPE) {
    if (v[SERVER_TIME_ESCAPE] !== true)
      throw new ArtifactValueError(`${at}: write { "$serverTime": true }`);
    if (inArray)
      throw new ArtifactValueError(`${at}: "$serverTime" cannot be used inside an array`);
    return dec.serverTime();
  }
  if (esc !== null)
    throw new ArtifactValueError(
      `${at}: "${esc}" is not a known escape (only "$date" and "$serverTime") — a map with one key cannot start it with "$"`,
    );
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v))
    out[k] = decodeAt(x, where ? `${where}.${k}` : k, inArray, dec);
  return out;
}

export function decodeJsonValue<T>(value: unknown, dec: ValueDecoder<T>): unknown {
  return decodeAt(value, '', false, dec);
}

/** A DOCUMENT body: a JSON object (its top level is the document's fields, never an escape). */
export function decodeJsonDocument<T>(
  value: unknown,
  dec: ValueDecoder<T>,
): Record<string, unknown> {
  if (!isPlain(value)) throw new ArtifactValueError('A document is a JSON object');
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(value)) out[k] = decodeAt(x, k, false, dec);
  return out;
}

/** What the backend supplies to recognise a stored timestamp on the way out. */
export interface ValueEncoder {
  /** The instant, when `v` is the store's timestamp type; else null. */
  asDate(v: unknown): Date | null;
  /** Anything else that is not plain JSON (a reference, a geo point, bytes) → a JSON stand-in. */
  other?(v: unknown): unknown;
}

/** A stored value → JSON for the API: timestamps become { "$date": ISO }; maps and arrays are walked. */
export function encodeJsonValue(value: unknown, enc: ValueEncoder): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  const at = value instanceof Date ? value : enc.asDate(value);
  if (at) return dateEscape(at);
  if (Array.isArray(value)) return value.map((x) => encodeJsonValue(x, enc));
  if (!isPlain(value)) return enc.other ? enc.other(value) : String(value);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(value)) out[k] = encodeJsonValue(x, enc);
  return out;
}

// ───────────────────────── limits ─────────────────────────

/** One batch: at most this many writes, all or nothing (Firestore's own ceiling is 500). */
export const ARTIFACT_DATA_BATCH_MAX = 400;
/** A collection list returns this many unless `limit` says otherwise (max LIST_LIMIT_MAX = 500). */
export const ARTIFACT_DATA_LIST_DEFAULT = 100;
/** A files list returns at most this many (the same as the driver's db.storage.list). */
export const ARTIFACT_FILE_LIST_MAX = 1000;
/** Filters in one list call. */
export const ARTIFACT_DATA_WHERE_MAX = 10;

// ───────────────────────── shapes ─────────────────────────

const PathIn = z.string().max(ARTIFACT_PATH_MAX);
/** Any JSON object — checked for the escapes by the backend (decodeJsonDocument). */
const DocumentIn = z.record(z.string(), z.unknown());

/** A Firestore document as the API answers it. `path` is in the artifact's own view ('/my/doc'). */
export const ArtifactDataDocSchema = z.object({
  id: z.string(),
  path: z.string(),
  exists: z.boolean(),
  /** null when it does not exist. Timestamps are { "$date": ISO }. */
  data: z.record(z.string(), z.unknown()).nullable(),
});
export type ArtifactDataDoc = z.infer<typeof ArtifactDataDocSchema>;

/** A collection page: `next_cursor` is the last document's id (pass it as start_after), or null at the end. */
export const ArtifactDataListSchema = z.object({
  data: z.array(ArtifactDataDocSchema),
  next_cursor: z.string().nullable(),
});
export type ArtifactDataList = z.infer<typeof ArtifactDataListSchema>;

export const WhereOpSchema = z.enum(WHERE_OPS as unknown as [WhereOp, ...WhereOp[]]);
/** [field, op, value] — exactly the driver's ListQuery.where item. */
export const ArtifactDataWhereSchema = z.tuple([
  z.string().min(1).max(512),
  WhereOpSchema,
  z.unknown(),
]);
export type ArtifactDataWhere = [field: string, op: WhereOp, value: unknown];

/** A list query, door-neutral (REST parses its query string into this; MCP passes it as arguments). */
export const ArtifactDataQuerySchema = z.object({
  where: z.array(ArtifactDataWhereSchema).max(ARTIFACT_DATA_WHERE_MAX).optional(),
  orderBy: z.tuple([z.string().min(1).max(512), z.enum(['asc', 'desc'])]).optional(),
  limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(ARTIFACT_DATA_LIST_DEFAULT),
  /** A document id in this collection — the previous page's next_cursor. */
  startAfter: z.string().min(1).max(1500).optional(),
});
export type ArtifactDataQuery = z.infer<typeof ArtifactDataQuerySchema>;

/** One write of a batch. `path` is a DOCUMENT path in the artifact's own view. */
export const ArtifactDataWriteSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('set'),
      path: PathIn,
      data: DocumentIn,
      /** Merge into what is there instead of replacing it. */
      merge: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      path: PathIn,
      /** Keys may be dotted field paths ('stats.count'). The document must exist. */
      data: DocumentIn,
    })
    .strict(),
  z.object({ op: z.literal('delete'), path: PathIn }).strict(),
]);
export type ArtifactDataWrite = z.infer<typeof ArtifactDataWriteSchema>;

/** POST /v1/artifacts/{id}/data/batch, MCP artifact_data_batch. */
export const ArtifactDataBatchSchema = z
  .object({ writes: z.array(ArtifactDataWriteSchema).min(1).max(ARTIFACT_DATA_BATCH_MAX) })
  .strict();
export type ArtifactDataBatch = z.infer<typeof ArtifactDataBatchSchema>;
export const ArtifactDataBatchResSchema = z.object({
  ok: z.literal(true),
  /** How many writes were applied (all of them — a batch is atomic). */
  written: z.number().int().nonnegative(),
});

/** One of the artifact's files (paths in its own view). */
export const ArtifactDataFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  content_type: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type ArtifactDataFile = z.infer<typeof ArtifactDataFileSchema>;

/**
 * `?where=field,op,value` (REST). The FIRST two commas split; the value is
 * everything after, read as JSON when it parses (`5`, `true`, `"x"`,
 * `["a","b"]`, `{"$date":"…"}`) and as a plain string otherwise — so
 * `where=status,==,open` and `where=n,>,5` both do what they look like.
 * Returns null when the text is not of that shape or the op is unknown.
 */
export function parseWhereParam(text: string): ArtifactDataWhere | null {
  const a = text.indexOf(',');
  const b = a < 0 ? -1 : text.indexOf(',', a + 1);
  if (a <= 0 || b < 0) return null;
  const field = text.slice(0, a).trim();
  const op = text.slice(a + 1, b).trim();
  const raw = text.slice(b + 1);
  if (!field || !(WHERE_OPS as readonly string[]).includes(op)) return null;
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    /* a bare word: the string itself */
  }
  return [field, op as WhereOp, value];
}

/** The other direction (the SDK builds its query string with this). */
export const formatWhereParam = ([field, op, value]: ArtifactDataWhere): string =>
  `${field},${op},${JSON.stringify(value)}`;

/** `?order_by=field` or `field,desc`. */
export function parseOrderByParam(text: string): [string, 'asc' | 'desc'] | null {
  const [field, dir, ...rest] = text.split(',').map((s) => s.trim());
  if (!field || rest.length) return null;
  if (dir !== undefined && dir !== '' && dir !== 'asc' && dir !== 'desc') return null;
  return [field, dir === 'desc' ? 'desc' : 'asc'];
}
