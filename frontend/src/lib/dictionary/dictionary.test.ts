import { describe, expect, it } from 'vitest';
import {
  dictionaryAccessRows,
  dictionarySettingsFor,
  duplicateKeys,
  keyError,
  moveRow,
  myDictionaryReach,
  ownedDictionaries,
  replaceOf,
  retype,
  rowOf,
  rowsSignature,
  splitDictionaries,
  valueOf,
  type EntryRow,
} from './store';

const row = (key: string, type: EntryRow['type'], text: string): EntryRow => ({
  rid: key,
  key,
  type,
  text,
});

describe('dictionary rows', () => {
  it('strings are Text; everything else JSON (objects pretty)', () => {
    expect(rowOf('A', 'hi')).toMatchObject({ type: 'text', text: 'hi' });
    expect(rowOf('N', 42)).toMatchObject({ type: 'json', text: '42' });
    expect(rowOf('B', false)).toMatchObject({ type: 'json', text: 'false' });
    expect(rowOf('Z', null)).toMatchObject({ type: 'json', text: 'null' });
    expect(rowOf('O', { a: [1, 2] })).toMatchObject({
      type: 'json',
      text: '{\n  "a": [\n    1,\n    2\n  ]\n}',
    });
  });

  it('switching type keeps the meaning', () => {
    const t = row('A', 'text', 'hello');
    const j = retype(t, 'json');
    expect(j).toMatchObject({ type: 'json', text: '"hello"' });
    expect(retype(j, 'text')).toMatchObject({ type: 'text', text: 'hello' });
    // JSON that is not a string stays its source as text.
    expect(retype(row('N', 'json', '42'), 'text')).toMatchObject({ type: 'text', text: '42' });
  });

  it('values: Text is a string, JSON is parsed (or says why not)', () => {
    expect(valueOf(row('A', 'text', '42'))).toEqual({ ok: true, value: '42' });
    expect(valueOf(row('A', 'json', '42'))).toEqual({ ok: true, value: 42 });
    expect(valueOf(row('A', 'json', '[1, {"b": true}]'))).toEqual({
      ok: true,
      value: [1, { b: true }],
    });
    expect(valueOf(row('A', 'json', '{nope'))).toMatchObject({ ok: false });
    expect(valueOf(row('A', 'json', '  '))).toMatchObject({ ok: false });
  });

  it('keys follow the shared rule and must be unique', () => {
    const none = new Set<string>();
    expect(keyError('API_URL', none)).toBeNull();
    expect(keyError('theme.primary', none)).toBeNull();
    expect(keyError('limits:daily', none)).toBeNull();
    expect(keyError('', none)).toMatch(/required/);
    expect(keyError('.dot', none)).toBeTruthy();
    expect(keyError('has space', none)).toBeTruthy();
    expect(keyError('x'.repeat(129), none)).toBeTruthy();
    const rows = [row('A', 'text', '1'), row('A', 'text', '2'), row('B', 'text', '')];
    expect([...duplicateKeys(rows)]).toEqual(['A']);
    expect(keyError('A', duplicateKeys(rows))).toMatch(/twice/);
  });

  it('replace: the rows in order, or null when one is invalid', () => {
    expect(replaceOf([row('A', 'text', 'x'), row('N', 'json', '{"a":1}')])).toEqual([
      { key: 'A', value: 'x' },
      { key: 'N', value: { a: 1 } },
    ]);
    expect(replaceOf([row('A', 'json', '{')])).toBeNull();
    expect(replaceOf([row('A', 'text', 'x'), row('A', 'text', 'y')])).toBeNull();
  });

  it('dirty ignores local ids; rows move up and down', () => {
    const a = [row('A', 'text', '1')];
    expect(rowsSignature(a)).toBe(rowsSignature([{ ...a[0]!, rid: 'other' }]));
    expect(moveRow(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveRow(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveRow(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});

describe('dictionary lists and settings', () => {
  it('splits active / archived; owned ones only for granting', () => {
    const r = splitDictionaries([
      { name: 'b', archivedAt: null },
      { name: 'a', archivedAt: null },
      { name: 'z', archivedAt: 5 },
    ]);
    expect(r.active.map((d) => d.name)).toEqual(['a', 'b']);
    expect(r.archived.map((d) => d.name)).toEqual(['z']);
    const list: { name: string; access: Record<string, 'owner' | 'editor' | 'viewer'> }[] = [
      { name: 'mine', access: { u1: 'owner' } },
      { name: 'theirs', access: { u2: 'owner', u1: 'editor' } },
    ];
    expect(ownedDictionaries(list, 'u1').map((d) => d.name)).toEqual(['mine']);
  });

  it('settings: the owner sees all, others only Subscribers', () => {
    expect(dictionarySettingsFor('owner').map((s) => s.id)).toEqual([
      'general',
      'people',
      'subscribers',
    ]);
    expect(dictionarySettingsFor('editor').map((s) => s.id)).toEqual(['subscribers']);
    expect(dictionarySettingsFor('viewer').map((s) => s.id)).toEqual(['subscribers']);
    expect(dictionarySettingsFor(null)).toEqual([]);
  });

  it('reach and people', () => {
    const d = {
      access: { u1: 'owner' as const, u2: 'viewer' as const, u3: 'editor' as const },
      boards: {},
      archivedAt: null,
    };
    expect(myDictionaryReach(d, 'u1')).toBe('manage');
    expect(myDictionaryReach(d, 'u3')).toBe('write');
    expect(myDictionaryReach(d, 'u2')).toBe('read');
    expect(myDictionaryReach({ ...d, archivedAt: 1 }, 'u3')).toBe('read');
    expect(myDictionaryReach(d, 'nobody')).toBeNull();
    expect(dictionaryAccessRows(d).map((r) => r.uid)).toEqual(['u1', 'u3', 'u2']);
  });
});
