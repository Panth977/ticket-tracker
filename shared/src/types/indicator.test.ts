import { describe, expect, it } from 'vitest';
import {
  defaultIndicator,
  INDICATOR_COLORS,
  INDICATOR_ICONS,
  INDICATOR_PATH_RE,
  indicatorColor,
  indicatorOf,
  IndicatorSchema,
  legacyColor,
  MEMORY_DEFAULT_INDICATOR,
} from './indicator.js';
import { BoardPatchSchema } from '../commands/boards.js';
import { StageSchema } from './board.js';

describe('IndicatorSchema', () => {
  it('accepts each kind', () => {
    for (const i of [
      { kind: 'color', color: '#6366f1' },
      { kind: 'icon', icon: 'rocket', color: '#EF4444' },
      { kind: 'emoji', emoji: '🚀' },
      { kind: 'emoji', emoji: '👩🏽‍💻' },
      { kind: 'emoji', emoji: '🇮🇳' },
      { kind: 'emoji', emoji: '❤️' },
      { kind: 'image', path: 'indicators/uid_1/abc123/logo.png' },
    ])
      expect(IndicatorSchema.safeParse(i).success, JSON.stringify(i)).toBe(true);
  });

  it('refuses typed text, unknown icons, bad colours, foreign paths, extra keys', () => {
    for (const i of [
      { kind: 'emoji', emoji: 'abc' },
      { kind: 'emoji', emoji: '' },
      { kind: 'emoji', emoji: '🚀'.repeat(20) },
      { kind: 'icon', icon: 'not-an-icon', color: '#000000' },
      { kind: 'icon', icon: 'rocket' },
      { kind: 'color', color: 'blue' },
      { kind: 'color', color: '#fff' },
      { kind: 'image', path: 'users/u/avatar/1.webp' },
      { kind: 'image', path: 'indicators/u/short/x.png' },
      { kind: 'image', path: 'indicators/u/abcdef/a/b.png' },
      { kind: 'color', color: '#000000', extra: 1 },
      { kind: 'text', text: 'A' },
    ])
      expect(IndicatorSchema.safeParse(i).success, JSON.stringify(i)).toBe(false);
  });

  it('path regex: indicators/{uid}/{fileId}/{name}', () => {
    expect(INDICATOR_PATH_RE.test('indicators/u/abcdef/x y.png')).toBe(true);
    expect(INDICATOR_PATH_RE.test('indicators/u/abc/x.png')).toBe(false);
  });
});

describe('indicatorOf — legacy fields', () => {
  it('its own indicator wins', () => {
    const i = { kind: 'emoji', emoji: '🧪' } as const;
    expect(indicatorOf({ indicator: i, color: 'red', icon: 'bug' })).toBe(i);
  });
  it('emoji icon (artifact / memory) → emoji', () => {
    expect(indicatorOf({ icon: '📊' })).toEqual({ kind: 'emoji', emoji: '📊' });
  });
  it('known icon name + colour → tinted icon', () => {
    expect(indicatorOf({ icon: 'bug', color: 'red' })).toEqual({
      kind: 'icon',
      icon: 'bug',
      color: '#ef4444',
    });
    expect(indicatorOf({ icon: 'bug' })).toEqual({
      kind: 'icon',
      icon: 'bug',
      color: INDICATOR_COLORS[0],
    });
  });
  it('named or hex colour → colour; a typed non-icon is ignored', () => {
    expect(indicatorOf({ color: 'slate', icon: 'hello' })).toEqual({
      kind: 'color',
      color: '#64748b',
    });
    expect(indicatorOf({ color: '#AABBCC' })).toEqual({ kind: 'color', color: '#aabbcc' });
  });
  it('nothing → a stable palette colour from the seed, or the fallback', () => {
    expect(indicatorOf({}, 'abc')).toEqual(defaultIndicator('abc'));
    expect(indicatorOf({}, 'abc')).toEqual(indicatorOf({ color: 'mauve' }, 'abc'));
    expect(indicatorOf({ icon: null }, 'm1', MEMORY_DEFAULT_INDICATOR)).toBe(
      MEMORY_DEFAULT_INDICATOR,
    );
    const c = defaultIndicator('board-1');
    expect(c.kind).toBe('color');
    expect(INDICATOR_COLORS).toContain((c as { color: string }).color);
  });
  it('legacyColor and indicatorColor', () => {
    expect(legacyColor('Blue')).toBe('#3b82f6');
    expect(legacyColor('nope')).toBeNull();
    expect(legacyColor(3)).toBeNull();
    expect(indicatorColor({ kind: 'icon', icon: 'zap', color: '#123456' })).toBe('#123456');
    expect(indicatorColor({ kind: 'emoji', emoji: '🚀' })).toBe(INDICATOR_COLORS[0]);
  });
  it('icon list has no duplicates', () => {
    expect(new Set(INDICATOR_ICONS).size).toBe(INDICATOR_ICONS.length);
  });
});

describe('schemas carrying indicators', () => {
  it('a stage takes an indicator and a description', () => {
    const base = { id: 'abc1234', name: 'Todo', color: 'blue', category: 'todo', position: 1 };
    expect(StageSchema.safeParse({ ...base, indicator: { kind: 'emoji', emoji: '📝' } }).success).toBe(
      true,
    );
    expect(StageSchema.safeParse({ ...base, description: 'x'.repeat(2001) }).success).toBe(false);
    expect(StageSchema.safeParse({ ...base, indicator: { kind: 'emoji', emoji: 'T' } }).success).toBe(
      false,
    );
  });
  it('BoardPatch: plain or legacy rich-text description, and an indicator', () => {
    expect(BoardPatchSchema.safeParse({ description: 'Plain' }).success).toBe(true);
    expect(
      BoardPatchSchema.safeParse({ description: { type: 'doc', content: [] } }).success,
    ).toBe(true);
    expect(
      BoardPatchSchema.safeParse({ indicator: { kind: 'color', color: '#22c55e' } }).success,
    ).toBe(true);
    expect(BoardPatchSchema.safeParse({ indicator: { kind: 'emoji', emoji: ':)' } }).success).toBe(
      false,
    );
  });
});
