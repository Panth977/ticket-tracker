/**
 * Firestore's write semantics over an ENCODED document (plain JSON):
 * create / set / set-merge / set-mergeFields / update / delete, and the
 * sentinels (increment, arrayUnion, arrayRemove, delete, serverTimestamp)
 * resolved against the value they replace.
 */
import type { Timestamp } from './values.js';
import {
  DbError,
  encode,
  encodedEqual,
  FieldPath,
  FieldValue,
  isPlainObject,
  segmentsOf,
  type PathLike,
} from './values.js';

type Json = Record<string, unknown>;
type IsRef = (v: unknown) => v is PathLike;

export type WriteOp =
  | { kind: 'create'; data: Json }
  | { kind: 'set'; data: Json; merge?: boolean; mergeFields?: string[][] }
  | { kind: 'update'; pairs: [string[], unknown][]; precondition?: { exists?: boolean } }
  | { kind: 'delete'; precondition?: { exists?: boolean } };

const DELETE = Symbol('delete');

/** One value, sentinels resolved against `current` (the encoded value it replaces). */
function resolve(
  v: unknown,
  current: unknown,
  now: Timestamp,
  isRef: IsRef,
  merge: boolean,
): unknown {
  if (v instanceof FieldValue) {
    switch (v.kind) {
      case 'delete':
        return DELETE;
      case 'serverTimestamp':
        return encode(now, isRef);
      case 'increment': {
        const n = v.operand as number;
        return typeof current === 'number' ? current + n : n;
      }
      case 'arrayUnion': {
        const base = Array.isArray(current) ? [...current] : [];
        for (const e of v.operand as unknown[]) {
          const x = encode(e, isRef);
          if (!base.some((b) => encodedEqual(b, x))) base.push(x);
        }
        return base;
      }
      case 'arrayRemove': {
        const drop = (v.operand as unknown[]).map((e) => encode(e, isRef));
        return Array.isArray(current)
          ? current.filter((b) => !drop.some((x) => encodedEqual(b, x)))
          : [];
      }
    }
  }
  if (isPlainObject(v)) {
    const base = merge && isPlainObject(current) ? { ...current } : {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      const r = resolve(
        x,
        merge || isPlainObject(current) ? (current as Json | undefined)?.[k] : undefined,
        now,
        isRef,
        merge,
      );
      if (r === DELETE) delete base[k];
      else base[k] = r;
    }
    return base;
  }
  return encode(v, isRef);
}

function getAt(doc: Json, segs: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const s of segs) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

function setAt(doc: Json, segs: readonly string[], value: unknown): void {
  let cur = doc;
  for (const s of segs.slice(0, -1)) {
    const next = cur[s];
    if (!isPlainObject(next)) cur[s] = {};
    cur = cur[s] as Json;
  }
  const last = segs[segs.length - 1]!;
  if (value === DELETE) delete cur[last];
  else cur[last] = value;
}

function deleteAt(doc: Json, segs: readonly string[]): void {
  let cur: unknown = doc;
  for (const s of segs.slice(0, -1)) {
    if (!isPlainObject(cur)) return;
    cur = cur[s];
  }
  if (isPlainObject(cur)) delete cur[segs[segs.length - 1]!];
}

/**
 * Apply one write to the current encoded document (undefined = missing).
 * Returns the new document, or undefined for a delete.
 */
export function applyWrite(
  path: string,
  current: Json | undefined,
  op: WriteOp,
  now: Timestamp,
  isRef: IsRef,
): Json | undefined {
  switch (op.kind) {
    case 'create':
      if (current) throw new DbError('ALREADY_EXISTS', `Document already exists: ${path}`);
      return resolve(op.data, undefined, now, isRef, false) as Json;
    case 'set': {
      if (op.mergeFields) {
        const next: Json = structuredClone(current ?? {});
        for (const segs of op.mergeFields) {
          const r = resolve(getAt(op.data, segs), getAt(next, segs), now, isRef, false);
          if (r === undefined) deleteAt(next, segs);
          else setAt(next, segs, r);
        }
        return next;
      }
      if (op.merge) return resolve(op.data, current ?? {}, now, isRef, true) as Json;
      return resolve(op.data, undefined, now, isRef, false) as Json;
    }
    case 'update': {
      if (!current) throw new DbError('NOT_FOUND', `No document to update: ${path}`);
      const next: Json = structuredClone(current);
      for (const [segs, value] of op.pairs) {
        if (value === undefined) continue;
        setAt(next, segs, resolve(value, getAt(next, segs), now, isRef, false));
      }
      return next;
    }
    case 'delete':
      if (op.precondition?.exists && !current)
        throw new DbError('NOT_FOUND', `No document to delete: ${path}`);
      return undefined;
  }
}

/** update()'s two call forms → (segments, value) pairs. */
export function updatePairs(args: unknown[]): {
  pairs: [string[], unknown][];
  precondition?: { exists?: boolean };
} {
  const [first, ...rest] = args;
  if (typeof first === 'string' || first instanceof FieldPath) {
    const pairs: [string[], unknown][] = [];
    const list = [first, ...rest];
    let precondition: { exists?: boolean } | undefined;
    if (list.length % 2 === 1) precondition = list.pop() as { exists?: boolean };
    for (let i = 0; i < list.length; i += 2)
      pairs.push([segmentsOf(list[i] as string | FieldPath), list[i + 1]]);
    return { pairs, precondition };
  }
  if (!isPlainObject(first))
    throw new DbError(
      'INVALID_ARGUMENT',
      'Update() requires either a single JavaScript object or an alternating list of field/value pairs that can be followed by an optional precondition.',
    );
  if (Object.keys(first).length === 0)
    throw new DbError('INVALID_ARGUMENT', 'At least one field must be updated.');
  return {
    pairs: Object.entries(first).map(([k, v]) => [segmentsOf(k), v] as [string[], unknown]),
    precondition: rest[0] as { exists?: boolean } | undefined,
  };
}

export function mergeFieldSegments(fields: Array<string | FieldPath>): string[][] {
  return fields.map((f) => segmentsOf(f));
}
