import { describe, expect, it } from 'vitest';
import { hueFor, initials, maskEmail } from './format';

describe('people/format', () => {
  it('initials', () => {
    expect(initials('Panth Patel')).toBe('PP');
    expect(initials(' priya ')).toBe('P');
    expect(initials('')).toBe('?');
    expect(initials('a b c')).toBe('AC');
  });
  it('hueFor is stable', () => {
    expect(hueFor('uid1')).toBe(hueFor('uid1'));
  });
  it('maskEmail', () => {
    expect(maskEmail('alice@acme.com')).toBe('a***@acme.com');
  });
});
