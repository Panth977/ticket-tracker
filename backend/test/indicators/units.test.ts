/** indicators.html — the pure helpers behind the commands. */
import { describe, expect, it } from 'vitest';
import type { Stage } from '@tm/shared';
import { withStageMarks } from '../../src/commands/boardUpdate.js';
import { markOnCreate, markPatch } from '../../src/commands/indicatorShared.js';

const st = (id: string, extra: Partial<Stage> = {}): Stage =>
  ({ id, name: id, color: 'blue', category: 'todo', position: 1, ...extra }) as Stage;
const EMOJI = { kind: 'emoji', emoji: '🚀' } as const;
const ICON = { kind: 'icon', icon: 'bug', color: '#ef4444' } as const;

describe('withStageMarks', () => {
  it('keeps what an old client left out; null / blank description clears', () => {
    const old = [st('a', { indicator: EMOJI, description: 'A' }), st('b')];
    const [a, b] = withStageMarks(old, [st('a'), st('b', { description: '  ' as string })]);
    expect(a).toMatchObject({ indicator: EMOJI, description: 'A' });
    expect(b!.description).toBeUndefined();
    expect('indicator' in b!).toBe(false);
    const [c] = withStageMarks(old, [st('a', { description: null })]);
    expect(c!.description).toBeUndefined();
  });
  it('an icon / colour indicator sets the column tint', () => {
    const [a] = withStageMarks([], [st('a', { indicator: ICON })]);
    expect(a).toMatchObject({ color: '#ef4444', indicator: ICON });
    const [b] = withStageMarks([], [st('b', { indicator: EMOJI, color: 'green' })]);
    expect(b!.color).toBe('green');
  });
});

describe('markOnCreate / markPatch', () => {
  const fallback = { kind: 'color', color: '#6366f1' } as const;
  it('indicator wins; icon kept in step', () => {
    expect(markOnCreate({ indicator: EMOJI, icon: '📊' }, fallback)).toEqual({
      indicator: EMOJI,
      icon: '🚀',
    });
    expect(markOnCreate({ indicator: ICON }, fallback)).toEqual({ indicator: ICON, icon: null });
  });
  it('an old client: emoji icon → emoji indicator; typed text → fallback', () => {
    expect(markOnCreate({ icon: '📊' }, fallback)).toEqual({
      indicator: { kind: 'emoji', emoji: '📊' },
      icon: '📊',
    });
    expect(markOnCreate({ icon: 'X' }, fallback)).toEqual({ indicator: fallback, icon: null });
    expect(markOnCreate({}, fallback)).toEqual({ indicator: fallback, icon: null });
  });
  it('patch', () => {
    expect(markPatch({})).toEqual({});
    expect(markPatch({ indicator: ICON })).toEqual({ indicator: ICON, icon: null });
    expect(markPatch({ icon: null })).toEqual({ icon: null });
    expect(markPatch({ icon: '📊' })).toEqual({
      indicator: { kind: 'emoji', emoji: '📊' },
      icon: '📊',
    });
  });
});
