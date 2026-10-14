/**
 * Values on the live wire (JSON), both ways:
 *
 *   Timestamp          { "__ts": <epoch ms> }
 *   GeoPoint           { "__geo": [lat, lng] }
 *   DocumentReference  { "__ref": "<path>" }
 *   bytes              { "__bytes": "<base64>" }
 *   a write sentinel   { "__fv": "increment" | "arrayUnion" | "arrayRemove" | "delete" | "serverTimestamp", "v": … }
 *                      (client → server only)
 *
 * The same tags the SQLite store uses on disk, so the browser's VM adapter
 * and the server share one vocabulary.
 */
import { db, DocumentReference, FieldValue, GeoPoint, Timestamp } from '../db/index.js';

const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** A value read from the database → JSON for the wire. */
export function toWire(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return v ?? null;
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (v instanceof GeoPoint) return { __geo: [v.latitude, v.longitude] };
  if (v instanceof DocumentReference) return { __ref: (v as unknown as { path: string }).path };
  if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(toWire);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toWire(x);
  return out;
}

/** JSON from the wire → values the database port takes (sentinels included). */
export function fromWire(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(fromWire);
  if (!plain(v)) return v;
  const keys = Object.keys(v);
  if (typeof v.__fv === 'string') {
    const arg = v.v;
    switch (v.__fv) {
      case 'increment':
        return FieldValue.increment(Number(arg));
      case 'arrayUnion':
        return FieldValue.arrayUnion(...((arg as unknown[]) ?? []).map(fromWire));
      case 'arrayRemove':
        return FieldValue.arrayRemove(...((arg as unknown[]) ?? []).map(fromWire));
      case 'delete':
        return FieldValue.delete();
      case 'serverTimestamp':
        return FieldValue.serverTimestamp();
    }
    throw new Error(`Unknown sentinel ${String(v.__fv)}`);
  }
  if (keys.length === 1) {
    if (typeof v.__ts === 'number') return Timestamp.fromMillis(v.__ts);
    if (Array.isArray(v.__geo)) return new GeoPoint(Number(v.__geo[0]), Number(v.__geo[1]));
    if (typeof v.__ref === 'string') return db().doc(v.__ref);
    if (typeof v.__bytes === 'string') return Buffer.from(v.__bytes, 'base64');
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = fromWire(v[k]);
  return out;
}

/** The value a write leaves, for rules: sentinels resolved the way the store will resolve them. */
export function resolveForRules(value: unknown, current: unknown): unknown {
  if (value instanceof FieldValue) {
    const fv = value as unknown as { kind?: string; operand?: unknown };
    switch (fv.kind) {
      case 'increment':
        return (typeof current === 'number' ? current : 0) + Number(fv.operand);
      case 'serverTimestamp':
        return Timestamp.now();
      case 'arrayUnion': {
        const base = Array.isArray(current) ? [...current] : [];
        for (const e of fv.operand as unknown[])
          if (!base.some((b) => JSON.stringify(toWire(b)) === JSON.stringify(toWire(e))))
            base.push(e);
        return base;
      }
      case 'arrayRemove': {
        const drop = (fv.operand as unknown[]).map((e) => JSON.stringify(toWire(e)));
        return Array.isArray(current)
          ? current.filter((b) => !drop.includes(JSON.stringify(toWire(b))))
          : [];
      }
      case 'delete':
        return undefined;
    }
  }
  if (plain(value)) {
    const base: Record<string, unknown> = {};
    const cur = plain(current) ? current : {};
    for (const [k, x] of Object.entries(value)) {
      const r = resolveForRules(x, cur[k]);
      if (r !== undefined) base[k] = r;
    }
    return base;
  }
  return value;
}
