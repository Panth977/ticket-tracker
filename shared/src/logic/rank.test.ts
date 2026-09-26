import { describe, expect, it } from 'vitest';
import { between, betweenN, compareRank, rankAt } from './rank.js';

const sorted = (xs: string[]) => [...xs].sort(compareRank);

describe('rank.between', () => {
  it('first key in an empty list', () => {
    expect(between(null, null)).toBeTypeOf('string');
  });
  it('insert first / last / middle', () => {
    const a = between(null, null);
    const top = between(null, a);
    const end = between(a, null);
    const mid = between(top, a);
    expect(top < a).toBe(true);
    expect(a < end).toBe(true);
    expect(top < mid && mid < a).toBe(true);
  });
  it('rejects neighbours in the wrong order or equal', () => {
    const a = between(null, null);
    const b = between(a, null);
    expect(() => between(b, a)).toThrow(RangeError);
    expect(() => between(a, a)).toThrow(RangeError);
  });
  it('many inserts at the same spot stay strictly ordered', () => {
    const lo = between(null, null);
    let hi = between(lo, null);
    const keys = [lo, hi];
    for (let i = 0; i < 500; i++) {
      hi = between(lo, hi); // always squeeze right after lo
      keys.push(hi);
    }
    expect(new Set(keys).size).toBe(keys.length);
    const s = sorted(keys);
    for (let i = 1; i < s.length; i++) expect(s[i - 1]! < s[i]!).toBe(true);
    expect(s[0]).toBe(lo);
  });
  it('many appends and prepends', () => {
    let first = between(null, null);
    let last = first;
    const list = [first];
    for (let i = 0; i < 300; i++) {
      last = between(last, null);
      first = between(null, first);
      list.push(last);
      list.unshift(first);
    }
    expect(sorted(list)).toEqual(list);
  });
  it('random inserts keep display order', () => {
    const list: string[] = [between(null, null)];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 400; i++) {
      const at = Math.floor(rnd() * (list.length + 1));
      list.splice(at, 0, rankAt(list, at));
    }
    expect(sorted(list)).toEqual(list);
  });
});

describe('rank helpers', () => {
  it('betweenN spreads keys', () => {
    const ks = betweenN(null, null, 10);
    expect(ks).toHaveLength(10);
    expect(sorted(ks)).toEqual(ks);
  });
  it('rankAt clamps the index', () => {
    const ks = betweenN(null, null, 3);
    expect(rankAt(ks, 99) > ks[2]!).toBe(true);
    expect(rankAt(ks, -5) < ks[0]!).toBe(true);
    expect(rankAt([], 0)).toBeTypeOf('string');
  });
});
