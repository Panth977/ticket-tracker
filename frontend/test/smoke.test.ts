import { describe, expect, it } from 'vitest';
import * as shared from '@tm/shared';

describe('@tm/frontend', () => {
  it('resolves @tm/shared', () => {
    expect(shared).toBeTypeOf('object');
  });
});
