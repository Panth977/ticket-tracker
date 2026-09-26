import { describe, expect, it } from 'vitest';
import type { Ticket } from '@tm/shared';
import { readState, stateQueryValues, withReadState } from './state';

describe('phase 6 legacy state', () => {
  it('reads the removed cancelled state as archived', () => {
    expect(readState('active')).toBe('active');
    expect(readState('archived')).toBe('archived');
    expect(readState('cancelled')).toBe('archived');
    expect(readState(undefined)).toBe('archived');
  });

  it('rewrites only `state`, and leaves a current ticket untouched', () => {
    const t = { id: 't1', key: 'ENG-42', state: 'cancelled' } as unknown as Ticket & { id: string };
    expect(withReadState(t)).toEqual({ id: 't1', key: 'ENG-42', state: 'archived' });
    const ok = { id: 't2', state: 'active' } as unknown as Ticket & { id: string };
    expect(withReadState(ok)).toBe(ok);
  });

  it('a query for archived also catches tickets still stored as cancelled', () => {
    expect(stateQueryValues(['archived'])).toEqual(['archived', 'cancelled']);
    expect(stateQueryValues(['active'])).toEqual(['active']);
  });
});
