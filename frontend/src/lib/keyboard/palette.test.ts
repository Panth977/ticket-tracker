import { describe, expect, it } from 'vitest';
import { filterItems, matchScore } from './palette.svelte';

describe('palette matching', () => {
  it('requires every word', () => {
    expect(
      matchScore('eng board', { label: 'Engineering', keywords: 'ENG board' }),
    ).toBeGreaterThan(0);
    expect(matchScore('ops', { label: 'Engineering' })).toBe(0);
  });
  it('ranks prefix first', () => {
    const r = filterItems('in', [
      { id: '1', label: 'My work', keywords: 'assigned in' },
      { id: '2', label: 'Inbox' },
    ]);
    expect(r.map((x) => x.id)).toEqual(['2', '1']);
  });
});
