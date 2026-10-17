import { describe, expect, it } from 'vitest';
import {
  DICTIONARY_KEY_RE,
  DictionaryValueSchema,
  dictionaryArtifactReach,
  dictionaryReach,
  entriesIn,
  entriesOut,
  entriesToEnv,
  isJsonValue,
  utf8Bytes,
} from './schema.js';

const base = {
  access: { u1: 'owner' as const, u2: 'viewer' as const },
  boards: {},
  archivedAt: null,
};

describe('dictionary values', () => {
  it('any JSON value, nothing else', () => {
    for (const v of ['x', 1, true, null, [1, [2, [3]]], { a: { b: [null] } }])
      expect(DictionaryValueSchema.safeParse(v).success).toBe(true);
    for (const v of [undefined, NaN, Infinity, new Date(), () => 1])
      expect(isJsonValue(v)).toBe(false);
  });
  it('keys: env names and dotted ones; not a leading dot or dash', () => {
    for (const k of ['API_URL', 'theme.primary', 'limits:daily', '_x', '9lives'])
      expect(DICTIONARY_KEY_RE.test(k)).toBe(true);
    for (const k of ['', '.x', '-x', 'a b', 'a/b', 'x'.repeat(129)])
      expect(DICTIONARY_KEY_RE.test(k)).toBe(false);
  });
  it('round-trips through the stored JSON text, order kept', () => {
    const list = [
      { key: 'b', value: { n: [1, [2]] } },
      { key: 'a', value: 'text' },
    ];
    const { entries, bytes } = entriesIn(list);
    expect(entries.map((e) => e.k)).toEqual(['b', 'a']);
    expect(bytes).toBeGreaterThan(0);
    expect(entriesOut({ entries })).toEqual(list);
  });
  it('refuses a key twice', () => {
    expect(() =>
      entriesIn([
        { key: 'a', value: 1 },
        { key: 'a', value: 2 },
      ]),
    ).toThrow(/twice/);
  });
  it('env: env-style keys only, strings as is, the rest as JSON, later wins', () => {
    expect(
      entriesToEnv([
        [
          { key: 'API', value: 'one' },
          { key: 'N', value: 5 },
          { key: 'theme.x', value: 'skip' },
        ],
        [
          { key: 'API', value: 'two' },
          { key: 'O', value: { a: 1 } },
        ],
      ]),
    ).toEqual({ API: 'two', N: '5', O: '{"a":1}' });
  });
  it('utf8Bytes counts like UTF-8', () => {
    expect(utf8Bytes('a')).toBe(1);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('€')).toBe(3);
    expect(utf8Bytes('📖')).toBe(4);
  });
});

describe('dictionaryReach', () => {
  it('own role, board grants as a ceiling, agent grants', () => {
    expect(dictionaryReach(base, { uid: 'u1' })).toBe('manage');
    expect(dictionaryReach(base, { uid: 'u2' })).toBe('read');
    expect(dictionaryReach(base, { uid: 'u3' })).toBe(null);
    const granted = { ...base, boards: { b1: 'write' as const, b2: 'read' as const } };
    expect(dictionaryReach(granted, { boardRoles: new Map([['b1', 'editor']]) })).toBe('write');
    expect(dictionaryReach(granted, { boardRoles: new Map([['b1', 'viewer']]) })).toBe('read');
    expect(dictionaryReach(granted, { boardRoles: new Map([['b2', 'admin']]) })).toBe('read');
    const agent = { ...base, agents: { ag_x: 'write' as const } };
    expect(dictionaryReach(agent, { agentId: 'ag_x' })).toBe('write');
    expect(dictionaryReach(agent, { agentId: 'ag_y' })).toBe(null);
  });
  it('archived: write becomes read, manage stays', () => {
    const d = { ...base, access: { ...base.access, u4: 'editor' as const }, archivedAt: 1 };
    expect(dictionaryReach(d, { uid: 'u4' })).toBe('read');
    expect(dictionaryReach(d, { uid: 'u1' })).toBe('manage');
  });
  it('an artifact page: grant is the ceiling, the viewer the floor', () => {
    const d = { artifacts: { a1: 'write' as const, a2: 'read' as const } };
    expect(dictionaryArtifactReach(d, 'a1', 'write')).toBe('write');
    expect(dictionaryArtifactReach(d, 'a1', 'read')).toBe('read');
    expect(dictionaryArtifactReach(d, 'a2', 'manage')).toBe('read');
    expect(dictionaryArtifactReach(d, 'a3', 'manage')).toBe(null);
    expect(dictionaryArtifactReach(d, 'a1', null)).toBe(null);
  });
});
