/** humanize(): a board script's own field keys (board-script.html) read as sentences. */
import { describe, expect, it } from 'vitest';
import { humanize, type ActivityLookups } from './activity';

const L = {
  stage: () => undefined,
  priority: () => undefined,
  tag: () => undefined,
  person: (uid: string) => ({ u1: 'Ada', u2: 'Grace' })[uid],
  field: () => undefined,
  ticket: () => undefined,
  date: () => 'Nov 3',
} as unknown as ActivityLookups;

describe('humanize · board script fields', () => {
  it('names a script key, people by name, and clears', () => {
    const say = (changes: Record<string, { from: unknown; to: unknown }>) =>
      humanize({ action: 'updated', changes } as never, L);
    expect(say({ 'fields.severity': { from: null, to: 'S2' } })).toEqual(['set severity to S2']);
    expect(say({ 'fields.backend': { from: [], to: ['u1', 'u2'] } })).toEqual([
      'set backend to Ada and Grace',
    ]);
    expect(say({ 'fields.backend': { from: ['u1'], to: [] } })).toEqual(['cleared backend']);
    // An f_ id with no definition is still a removed settings field.
    expect(say({ 'fields.f_gone': { from: null, to: 'x' } })).toEqual(['set a removed field to x']);
  });
});
