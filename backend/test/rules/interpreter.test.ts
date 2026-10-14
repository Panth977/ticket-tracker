/**
 * The rules interpreter on its own. Parity with Firebase itself is proven in
 * qaqc/rules/interpreter*.test.ts (emulator vs. interpreter, case by case).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allowed, RulePath } from '../../src/rules/evaluate.js';
import { parseExpr, parseRules, RulesSyntaxError } from '../../src/rules/parse.js';

const file = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

describe('rules parser', () => {
  it('parses the shipped firestore.rules and storage.rules', () => {
    expect(parseRules(file('firestore.rules')).service).toBe('cloud.firestore');
    expect(parseRules(file('storage.rules')).service).toBe('firebase.storage');
  });
  it('reports a syntax error with its line', () => {
    expect(() => parseRules('service cloud.firestore {\n match /x { allow read: if ; } }')).toThrow(
      RulesSyntaxError,
    );
    expect(() => parseRules('service cloud.firestore {\n match /x { allow read: if ; } }')).toThrow(
      /line 2/,
    );
  });
  it('parses path literals, ternaries and precedence', () => {
    expect(parseExpr('/databases/$(db)/documents/users/$(request.auth.uid)')).toMatchObject({
      t: 'path',
    });
    expect(parseExpr('a || b && c')).toMatchObject({ t: 'bin', op: '||' });
    expect(parseExpr('x is int ? 1 : 2')).toMatchObject({ t: 'cond' });
  });
});

describe('rules evaluation', () => {
  const rs = parseRules(`rules_version = '2';
    service cloud.firestore { match /databases/{database}/documents {
      function owner(uid) { return request.auth != null && request.auth.uid == uid; }
      match /notes/{id} {
        allow get: if owner(resource.data.owner);
        allow create: if owner(request.resource.data.owner) && request.resource.data.keys().hasOnly(['owner', 'text']);
        allow update: if request.resource.data.diff(resource.data).affectedKeys().hasOnly(['text']);
      }
      match /open/{path=**} { allow read: if true; }
      match /boom/{id} { allow get: if resource.data.missing == 1 || true; }
    } }`);
  const ev = (
    method: string,
    path: string,
    uid: string | null,
    resource: object | null,
    after?: object,
  ) =>
    allowed(rs, {
      path: `/databases/(default)/documents/${path}`,
      method,
      request: {
        auth: uid ? { uid, token: {} } : null,
        method,
        path,
        time: null,
        resource: after ? { data: after } : null,
      },
      resource: resource as never,
      lookup: { get: async () => null },
    });

  it('functions, request.auth, resource', async () => {
    expect(await ev('get', 'notes/n1', 'u1', { data: { owner: 'u1' } })).toBe(true);
    expect(await ev('get', 'notes/n1', 'u2', { data: { owner: 'u1' } })).toBe(false);
    expect(await ev('get', 'notes/n1', null, { data: { owner: 'u1' } })).toBe(false);
  });
  it('keys().hasOnly and diff().affectedKeys()', async () => {
    expect(await ev('create', 'notes/n2', 'u1', null, { owner: 'u1', text: 'hi' })).toBe(true);
    expect(await ev('create', 'notes/n2', 'u1', null, { owner: 'u1', text: 'hi', x: 1 })).toBe(
      false,
    );
    expect(
      await ev(
        'update',
        'notes/n2',
        'u1',
        { data: { owner: 'u1', text: 'a' } },
        { owner: 'u1', text: 'b' },
      ),
    ).toBe(true);
    expect(
      await ev(
        'update',
        'notes/n2',
        'u1',
        { data: { owner: 'u1', text: 'a' } },
        { owner: 'u2', text: 'a' },
      ),
    ).toBe(false);
  });
  it('{path=**} takes zero or more segments; read covers get and list', async () => {
    expect(await ev('get', 'open/a', null, null)).toBe(true);
    expect(await ev('list', 'open/a/b/c', null, null)).toBe(true);
    expect(await ev('create', 'open/a', null, null, {})).toBe(false);
  });
  it('an error on one side of || does not decide when the other side can', async () => {
    expect(await ev('get', 'boom/x', null, { data: {} })).toBe(true);
  });
  it('a path value prints as a path', () => {
    expect(String(new RulePath(['a', 'b']))).toBe('/a/b');
  });
});
