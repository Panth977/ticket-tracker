/** Values across the fence: what an artifact may write, and what it gets back. */
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import { SERVER_TIME } from '@tm/shared';
import {
  fromStored,
  isPlainObject,
  MAX_DEPTH,
  toStored,
  toStoredObject,
  ValueError,
  type WriteCodec,
} from './convert';

const NOW = { sentinel: true };
// The real Firestore Timestamp, to prove the codec the app uses round-trips.
const fs: WriteCodec = { date: (d) => Timestamp.fromDate(d), serverTime: () => NOW };
const asDate = (v: unknown) => (v instanceof Timestamp ? v.toDate() : null);

describe('toStored', () => {
  it('keeps plain data, converts Date and serverTime at any depth', () => {
    const d = new Date('2026-03-04T05:06:07.000Z');
    const out = toStored(
      {
        s: 'x',
        n: 1.5,
        b: false,
        z: null,
        d,
        at: SERVER_TIME,
        list: [d, { at: SERVER_TIME }, [1]],
      },
      fs,
    ) as Record<string, unknown>;
    expect(out.s).toBe('x');
    expect(out.z).toBeNull();
    expect(out.d).toBeInstanceOf(Timestamp);
    expect((out.d as Timestamp).toMillis()).toBe(d.getTime());
    expect(out.at).toBe(NOW);
    expect((out.list as unknown[])[0]).toBeInstanceOf(Timestamp);
    expect(((out.list as unknown[])[1] as { at: unknown }).at).toBe(NOW);
  });

  it('never returns the object it was given (the artifact keeps no handle on what is stored)', () => {
    const inner = { a: 1 };
    const out = toStored({ inner, list: [inner] }, fs) as { inner: object; list: object[] };
    expect(out.inner).not.toBe(inner);
    expect(out.list[0]).not.toBe(inner);
  });

  it('drops keys set to undefined, refuses undefined anywhere else', () => {
    expect(toStored({ a: 1, b: undefined }, fs)).toEqual({ a: 1 });
    expect(() => toStored([undefined], fs)).toThrow(ValueError);
    expect(() => toStored(undefined, fs)).toThrow(ValueError);
  });

  it('refuses everything that is not plain data', () => {
    class Thing {
      x = 1;
    }
    for (const v of [
      new Map(),
      new Set(),
      new Thing(),
      new Uint8Array(1),
      new ArrayBuffer(1),
      /re/,
      new Error('e'),
      () => 1,
      Symbol('s'),
      10n,
      new Date(NaN),
    ])
      expect(() => toStored({ v }, fs), String(v)).toThrow(ValueError);
    expect(new ValueError('x').code).toBe('invalid-argument');
  });

  it('stops at the nesting limit — which is also what stops a cycle', () => {
    let deep: unknown = 1;
    for (let i = 0; i < MAX_DEPTH; i++) deep = { d: deep };
    expect(() => toStored(deep, fs)).not.toThrow();
    expect(() => toStored({ d: deep }, fs)).toThrow(/nest/);
    const cyc: unknown[] = [];
    cyc.push(cyc);
    expect(() => toStored(cyc, fs)).toThrow(ValueError);
  });

  it('honours the codec: key rules and finite numbers (the RTDB flavour)', () => {
    const rt: WriteCodec = {
      date: (d) => d.getTime(),
      serverTime: () => ({ '.sv': 'timestamp' }),
      key: (k) => {
        if (k.includes('.')) throw new ValueError('bad key');
      },
      finiteOnly: true,
    };
    expect(toStored({ at: SERVER_TIME, when: new Date(5) }, rt)).toEqual({
      at: { '.sv': 'timestamp' },
      when: 5,
    });
    // The sentinel comes from the codec; a look-alike from the artifact is a key like any other.
    expect(() => toStored({ '.sv': 'timestamp' }, rt)).toThrow(ValueError);
    expect(() => toStored({ a: { 'b.c': 1 } }, rt)).toThrow(ValueError);
    expect(() => toStored(Infinity, rt)).toThrow(ValueError);
    expect(toStored(NaN, fs)).toBeNaN();
  });

  it('toStoredObject needs an object at the top', () => {
    expect(toStoredObject({ a: 1 }, fs, 'data')).toEqual({ a: 1 });
    for (const v of [null, [], 'x', 1, new Map()])
      expect(() => toStoredObject(v, fs, 'data')).toThrow(/data must be an object/);
  });
});

describe('fromStored', () => {
  it('turns timestamps into Dates at any depth and leaves plain data alone', () => {
    const t = Timestamp.fromMillis(1_700_000_000_000);
    expect(fromStored({ at: t, list: [t, { at: t }], n: 1, s: 'x', z: null }, asDate)).toEqual({
      at: new Date(1_700_000_000_000),
      list: [new Date(1_700_000_000_000), { at: new Date(1_700_000_000_000) }],
      n: 1,
      s: 'x',
      z: null,
    });
  });

  it('what is not in v1 (references, geo points, bytes) arrives as null, and the result always clones', () => {
    class Ref {
      firestore = { app: () => 'must never reach an artifact' };
      path = 'artifacts/x/db/data/a/b';
    }
    const out = fromStored({ ref: new Ref(), fn: () => 1, u: undefined, ok: 1 }, asDate);
    expect(out).toEqual({ ref: null, fn: null, u: null, ok: 1 });
    expect(() => structuredClone(out)).not.toThrow();
  });

  it('round-trips through the real Firestore Timestamp', () => {
    const d = new Date('2026-09-30T12:00:00.123Z');
    expect(fromStored(toStored({ d }, fs), asDate)).toEqual({ d });
  });
});

describe('isPlainObject', () => {
  it('is true only for {} and null-prototype objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const v of [null, [], new Date(), new Map(), 'x', 1, () => 1])
      expect(isPlainObject(v)).toBe(false);
  });
});
