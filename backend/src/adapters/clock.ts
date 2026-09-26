/**
 * Clock and IdGen. Commands read time from ctx.now and ids from ctx.ids; the
 * harness swaps in fixedClock / seqIds to make outputs deterministic.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { Clock, IdGen, Millis } from '@tm/shared';

export const systemClock = (): Clock => ({ now: () => Date.now() });

/** A settable clock for tests. */
export interface FixedClock extends Clock {
  set(t: Millis): void;
  advance(ms: number): void;
}
export function fixedClock(start: Millis): FixedClock {
  let t = start;
  return {
    now: () => t,
    set: (v) => void (t = v),
    advance: (ms) => void (t += ms),
  };
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const pick = (alphabet: string, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
};

export const randomIds = (): IdGen => ({
  id: () => pick(ALNUM, 20),
  shortId: () => pick(BASE36, 7),
  token: (bytes = 32) => randomBytes(bytes).toString('base64url'),
});

/** Deterministic ids for tests: id000001, s000001, tok000001 … (still valid shapes). */
export function seqIds(prefix = ''): IdGen {
  let n = 0;
  const next = () => String(++n).padStart(6, '0');
  return {
    id: () => `${prefix}id${next()}`.padEnd(20, '0').slice(0, 20),
    shortId: () => `s${next()}`.slice(0, 7),
    token: () => `${prefix}tok${next()}`,
  };
}
