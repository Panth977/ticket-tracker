import { describe, expect, it } from 'vitest';
import { keyLabel } from './keys';

describe('keyLabel', () => {
  it('mac', () => expect(keyLabel('mod+k', true)).toBe('⌘K'));
  it('pc', () => expect(keyLabel('mod+enter', false)).toBe('Ctrl+Enter'));
});
