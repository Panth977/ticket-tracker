import { describe, expect, it } from 'vitest';
import * as shared from '@tm/shared';

describe('@tm/backend', () => {
  it('resolves @tm/shared', () => {
    expect(shared).toBeTypeOf('object');
  });
});
