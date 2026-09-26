import { describe, expect, it } from 'vitest';
import * as shared from '../src/index.js';

describe('@tm/shared', () => {
  it('loads', () => {
    expect(shared).toBeTypeOf('object');
  });
});
