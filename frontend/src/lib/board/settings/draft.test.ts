import { describe, expect, it } from 'vitest';
import { FIELD_ID_RE } from '@tm/shared';
import { byPosition, fieldId, localId, renumber } from './draft.svelte';

describe('settings helpers', () => {
  it('localId: 7 chars base36, never one already taken', () => {
    const taken = Array.from({ length: 50 }, () => localId());
    for (const id of taken) expect(id).toMatch(/^[a-z0-9]{7}$/);
    expect(taken).not.toContain(localId(taken));
  });

  it("fieldId matches the contract ('f_' + 6)", () => {
    expect(fieldId()).toMatch(FIELD_ID_RE);
  });

  it('renumber / byPosition keep list order and positions in step', () => {
    const xs = [
      { id: 'b', position: 5 },
      { id: 'a', position: 1 },
    ];
    expect(byPosition(xs).map((x) => x.id)).toEqual(['a', 'b']);
    expect(renumber(xs)).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
    ]);
  });
});
