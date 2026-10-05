import { describe, expect, it } from 'vitest';
import { stageMark } from './stageMark';

describe('stageMark (indicators.html)', () => {
  it('a legacy stage: its named colour becomes a colour indicator and the tint', () => {
    expect(stageMark({ id: 's1', color: 'green' })).toEqual({
      indicator: { kind: 'color', color: '#22c55e' },
      color: '#22c55e',
      hint: null,
    });
  });
  it('an icon indicator tints with its own colour; the description is the hint', () => {
    const m = stageMark({
      id: 's2',
      color: 'blue',
      indicator: { kind: 'icon', icon: 'rocket', color: '#ef4444' },
      description: '  Shipped to users  ',
    });
    expect(m.indicator.kind).toBe('icon');
    expect(m.color).toBe('#ef4444');
    expect(m.hint).toBe('Shipped to users');
  });
  it('an emoji stage still gets a tint (the palette first colour)', () => {
    const m = stageMark({ id: 's3', indicator: { kind: 'emoji', emoji: '🚀' } });
    expect(m.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('stageChoices', () => {
  it('sorts by position and carries each mark', async () => {
    const { stageChoices } = await import('./stageMark');
    const rows = stageChoices([
      { id: 'b', name: 'Done', color: 'green', position: 2 },
      { id: 'a', name: 'To do', color: '#3b82f6', position: 1, description: 'Not started' },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['To do', 'Done']);
    expect(rows[0]).toMatchObject({ color: '#3b82f6', hint: 'Not started' });
  });
});
