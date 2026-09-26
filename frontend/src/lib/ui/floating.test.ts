import { describe, expect, it } from 'vitest';
import { computePosition } from './floating';

const rect = (top: number, left: number, w = 100, h = 30) => ({
  top,
  left,
  width: w,
  height: h,
  bottom: top + h,
  right: left + w,
});

describe('computePosition', () => {
  it('places below-start', () => {
    expect(
      computePosition(rect(10, 20), { width: 200, height: 100 }, 1000, 800, 'bottom-start', 6),
    ).toEqual({
      top: 46,
      left: 20,
    });
  });
  it('flips above when no room below', () => {
    const p = computePosition(
      rect(750, 20),
      { width: 200, height: 100 },
      1000,
      800,
      'bottom-start',
      6,
    );
    expect(p.top).toBe(644);
  });
  it('clamps into the viewport', () => {
    const p = computePosition(
      rect(10, 950),
      { width: 200, height: 100 },
      1000,
      800,
      'bottom-start',
      6,
    );
    expect(p.left).toBe(796);
  });
});
