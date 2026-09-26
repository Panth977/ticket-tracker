import { describe, expect, it } from 'vitest';
import {
  fmtCalls,
  fmtDuration,
  fmtTurns,
  fmtUsage,
  fmtUsd,
  fmtUsdExact,
  outcomeClass,
  outcomeTone,
  shortModel,
} from './format';

describe('fmtUsd', () => {
  it('shapes the amount by its size', () => {
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(0.004)).toBe('<$0.01');
    expect(fmtUsd(1.2345)).toBe('$1.23');
    expect(fmtUsd(9.999)).toBe('$10.00');
    expect(fmtUsd(12.34)).toBe('$12.3');
    expect(fmtUsd(99.96)).toBe('$100.0');
    expect(fmtUsd(402.27)).toBe('$402');
    expect(fmtUsd(1204.5)).toBe('$1,205');
  });
  it('treats junk as nothing', () => {
    expect(fmtUsd(NaN)).toBe('$0');
    expect(fmtUsd(-3)).toBe('$0');
  });
});

describe('fmtUsdExact', () => {
  it('always shows cents', () => {
    expect(fmtUsdExact(0)).toBe('$0.00');
    expect(fmtUsdExact(1.2)).toBe('$1.20');
    expect(fmtUsdExact(402.27)).toBe('$402.27');
    expect(fmtUsdExact(1204.5)).toBe('$1,204.50');
    expect(fmtUsdExact(0.001)).toBe('<$0.01');
  });
});

describe('fmtDuration', () => {
  it('picks the unit a person would', () => {
    expect(fmtDuration(0)).toBe('0 s');
    expect(fmtDuration(42_000)).toBe('42 s');
    expect(fmtDuration(59_400)).toBe('59 s');
    expect(fmtDuration(743_000)).toBe('12 min');
    expect(fmtDuration(3_600_000)).toBe('1 h');
    expect(fmtDuration(4_320_000)).toBe('1 h 12 min');
    expect(fmtDuration(26 * 3_600_000)).toBe('1 d 2 h');
    expect(fmtDuration(48 * 3_600_000)).toBe('2 d');
    expect(fmtDuration(-5)).toBe('0 s');
  });
});

describe('small words', () => {
  it('counts calls and turns', () => {
    expect(fmtCalls(46)).toBe('46 calls');
    expect(fmtCalls(1)).toBe('1 call');
    expect(fmtCalls(null)).toBeNull();
    expect(fmtTurns(9)).toBe('9 turns');
    expect(fmtTurns(1)).toBe('1 turn');
  });
  it('drops the vendor prefix from the model', () => {
    expect(shortModel('claude-fable-5-1')).toBe('fable-5-1');
    expect(shortModel('gpt-x')).toBe('gpt-x');
    expect(shortModel(null)).toBeNull();
  });
  it('summarises tokens', () => {
    expect(
      fmtUsage({ input: 1_200_000, output: 48_000, cacheRead: 900_000, cacheWrite: 80_000 }),
    ).toBe('1.2M in · 48k out · 980k cached');
    expect(fmtUsage({ input: 950, output: 1_500, cacheRead: 0, cacheWrite: 0 })).toBe(
      '950 in · 1.5k out · 0 cached',
    );
    expect(fmtUsage(null)).toBeNull();
  });
});

describe('outcome tones', () => {
  it('colours by what happened', () => {
    expect(outcomeTone('review')).toBe('success');
    expect(outcomeTone('waiting')).toBe('warning');
    expect(outcomeTone('blocked')).toBe('danger');
    expect(outcomeTone('failed')).toBe('danger');
    expect(outcomeTone('timeout')).toBe('danger');
    expect(outcomeTone('stopped')).toBe('neutral');
    expect(outcomeClass('review')).toBe('text-success');
    expect(outcomeClass('stopped')).toBe('text-muted');
  });
});
