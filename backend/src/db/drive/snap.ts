/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * What the router's routes share (router.ts, entityRouter.ts): snapshots of
 * documents read from Drive, and a write call turned into the SQLite
 * adapter's WriteOp.
 */
import { errors } from '@tm/shared';
import { updatePairs, type WriteOp } from '../sqlite/mutate.js';
import type * as P from '../types.js';
import { decodeJson, foreignSegments, toLocal } from './values.js';

export type Json = Record<string, unknown>;
export type Conv = P.FirestoreDataConverter<any> | null;

export const lastSeg = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
export const WRITE_RESULT = (Ts: P.TimestampStatic): P.WriteResult => ({ writeTime: Ts.now() });

/** What a snapshot needs of its reference. */
export interface SnapRef<T = P.DocumentData> extends P.DocumentReference<T> {
  readonly db: { Ts: P.TimestampStatic };
  readonly conv: Conv;
}

export function segsOf(field: unknown): string[] {
  if (typeof field === 'string') return field.split('.');
  const s = foreignSegments(field);
  if (!s) throw errors.invalid('Invalid field path');
  return s;
}

export class DriveRetry extends Error {
  constructor() {
    super('A Drive ticket changed while this transaction ran');
  }
}

export function getAt(doc: unknown, segs: readonly string[]): unknown {
  let cur = doc;
  for (const s of segs) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[s];
  }
  return cur;
}

// ─── snapshots ───────────────────────────────────────────────────────────────

export class RDocSnap<T = P.DocumentData> implements P.QueryDocumentSnapshot<T> {
  readonly exists: boolean;
  readonly createTime: P.Timestamp;
  readonly updateTime: P.Timestamp;
  readonly readTime: P.Timestamp;
  private decoded: Json | undefined;
  constructor(
    readonly ref: SnapRef<T>,
    /** Encoded document; undefined = missing. */
    readonly raw: Json | undefined,
  ) {
    this.exists = raw !== undefined;
    const now = ref.db.Ts.now();
    this.createTime = now;
    this.updateTime = now;
    this.readTime = now;
  }
  get id(): string {
    return this.ref.id;
  }
  rawData(): Json | undefined {
    if (this.raw === undefined) return undefined;
    this.decoded ??= decodeJson(this.raw, this.ref.db.Ts) as Json;
    return this.decoded;
  }
  data(): T {
    if (!this.exists) return undefined as T;
    if (this.ref.conv) {
      const plain = new RDocSnap(this.ref.withConverter(null) as SnapRef<any>, this.raw);
      return this.ref.conv.fromFirestore(plain as unknown as P.QueryDocumentSnapshot) as T;
    }
    return this.rawData() as T;
  }
  get(field: string | P.FieldPath): any {
    const segs = segsOf(field);
    return getAt(this.rawData(), segs);
  }
}

export class RQuerySnap<T> implements P.QuerySnapshot<T> {
  readonly readTime: P.Timestamp;
  constructor(
    readonly docs: P.QueryDocumentSnapshot<T>[],
    Ts: P.TimestampStatic,
  ) {
    this.readTime = Ts.now();
  }
  get size() {
    return this.docs.length;
  }
  get empty() {
    return this.docs.length === 0;
  }
  forEach(cb: (d: P.QueryDocumentSnapshot<T>) => void) {
    this.docs.forEach(cb);
  }
}

// ─── writes ──────────────────────────────────────────────────────────────────

export type Method = 'create' | 'set' | 'update' | 'delete';

/** A write call on a routed ref → the SQLite adapter's WriteOp (local value classes). */
export function toOp(ref: { conv: Conv }, method: Method, args: unknown[]): WriteOp {
  switch (method) {
    case 'create': {
      const data = ref.conv ? ref.conv.toFirestore(args[0] as any) : args[0];
      return { kind: 'create', data: toLocal(data) as Json };
    }
    case 'set': {
      const options = args[1] as P.SetOptions | undefined;
      const data = ref.conv
        ? options
          ? ref.conv.toFirestore(args[0] as any, options)
          : ref.conv.toFirestore(args[0] as any)
        : args[0];
      return {
        kind: 'set',
        data: toLocal(data) as Json,
        ...(options?.merge ? { merge: true } : {}),
        ...(options?.mergeFields ? { mergeFields: options.mergeFields.map(segsOf) } : {}),
      };
    }
    case 'update': {
      const { pairs, precondition } = updatePairs(args.map(toLocal));
      return { kind: 'update', pairs, ...(precondition ? { precondition } : {}) };
    }
    case 'delete':
      return {
        kind: 'delete',
        ...(args[0] ? { precondition: args[0] as { exists?: boolean } } : {}),
      };
  }
}
