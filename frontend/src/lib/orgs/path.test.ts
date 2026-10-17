import { describe, expect, it } from 'vitest';
import { parseOwnerPath, parseThingPath } from './path';

describe('thing paths (§AC)', () => {
  it('knows dictionaries, by id and owner-first by slug', () => {
    expect(parseThingPath('/dictionary/d_abc123/settings/people')).toEqual({
      kind: 'dictionary',
      ref: 'd_abc123',
      handle: null,
      rest: '/settings/people',
    });
    expect(parseThingPath('/acme/dictionary/deploy')).toEqual({
      kind: 'dictionary',
      ref: 'deploy',
      handle: 'acme',
      rest: '',
    });
    expect(parseOwnerPath('/acme/dictionary/deploy')).toBeNull();
    expect(parseOwnerPath('/acme')).toEqual({ handle: 'acme', rest: '' });
  });
});
