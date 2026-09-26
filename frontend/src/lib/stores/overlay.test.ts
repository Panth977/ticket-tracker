import { afterEach, describe, expect, it } from 'vitest';
import { _resetOverlays, applyOverlays, patchDoc } from './overlay';

afterEach(_resetOverlays);

describe('overlays', () => {
  it('merges dotted patches and rolls back', () => {
    const base = { id: 't1', title: 'a', fields: { x: 1, y: 2 } };
    const undo = patchDoc('boards/b/tickets/t1', { title: 'b', 'fields.x': 9 });
    expect(applyOverlays('boards/b/tickets/t1', base)).toEqual({
      id: 't1',
      title: 'b',
      fields: { x: 9, y: 2 },
    });
    expect(base.fields.x).toBe(1);
    undo();
    expect(applyOverlays('boards/b/tickets/t1', base)).toBe(base);
  });
  it('null hides the document', () => {
    patchDoc('p', null);
    expect(applyOverlays('p', { id: 'p' })).toBeUndefined();
  });
});
