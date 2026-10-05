/** Pure platform helpers — no emulator needed. */
import { describe, expect, it } from 'vitest';
import type { Ticket } from '@tm/shared';
import { buildCalendar } from '../../src/doors/ics.js';
import { findKeys } from '../../src/doors/hooks/github.js';
import { base62, safeEqual, sha256b64url } from '../../src/platform/crypto.js';
import { isPrivateIp } from '../../src/platform/net.js';
import {
  isAllowedRedirectUri,
  OAuthError,
  parseScopes,
  redirectWith,
} from '../../src/platform/oauth.js';
import { decodeCursor, encodeCursor } from '../../src/platform/resolve.js';

describe('crypto', () => {
  it('base62 is the right length and alphabet; safeEqual is exact', () => {
    const s = base62(32);
    expect(s).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(base62(32)).not.toBe(s);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('PKCE S256 matches RFC 7636 appendix B', () => {
    expect(sha256b64url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('oauth helpers', () => {
  it('redirect URIs: https, loopback http, private-use schemes; never script-ish or fragments', () => {
    for (const u of [
      'https://claude.ai/api/mcp/auth_callback',
      'http://127.0.0.1:33418/cb',
      'http://localhost/cb',
      'cursor://anysphere.cursor-retrieval/oauth/callback',
    ])
      expect(isAllowedRedirectUri(u), u).toBe(true);
    for (const u of [
      'http://example.com/cb',
      'javascript:alert(1)',
      'data:text/html,x',
      'https://x.example/cb#frag',
      'not a url',
    ])
      expect(isAllowedRedirectUri(u), u).toBe(false);
  });

  it('scopes: space / comma separated, phase-1 names expanded, unknown refused', () => {
    expect(parseScopes('board:read  comments:write,board:read')).toEqual([
      'board:read',
      'comments:read',
      'comments:write',
      'files:read',
      'files:write',
    ]);
    expect(parseScopes('boards:read')).toEqual(['board:read']);
    expect(parseScopes('')).toEqual([]);
    expect(() => parseScopes('tickets:read admin:all')).toThrow(OAuthError);
  });

  it('scopes: generic OAuth/OIDC scopes a client adds are ignored, not refused', () => {
    expect(parseScopes('openid offline_access tickets:read profile email')).toEqual(
      parseScopes('tickets:read'),
    );
    expect(parseScopes('openid offline_access')).toEqual([]);
  });

  it('redirectWith keeps the registered query', () => {
    expect(redirectWith('https://c.example/cb?x=1', { code: 'abc', state: null })).toBe(
      'https://c.example/cb?x=1&code=abc',
    );
  });
});

describe('net', () => {
  it('refuses private, loopback, link-local and mapped addresses', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('example.com')).toBe(true);
  });
});

describe('cursors', () => {
  it('round-trip and reject garbage', () => {
    expect(decodeCursor(encodeCursor({ id: 'a', u: 3 }))).toEqual({ id: 'a', u: 3 });
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('%%%')).toThrow();
  });
});

describe('github keys', () => {
  it('finds keys in branch names (any case), titles and commit messages, once each', () => {
    expect(
      findKeys('feature/eng-42-login', 'Fix ENG-42 and SUP-9', 'no keys here, x-1 is too short'),
    ).toEqual(['ENG-42', 'SUP-9']);
  });
});

describe('ics', () => {
  const t = (over: Partial<Ticket>): Ticket =>
    ({
      key: 'ENG-1',
      title: 'A, b; c',
      dueAt: Date.UTC(2030, 0, 2, 9, 30),
      dueAllDay: false,
      updatedAt: 0,
      ...over,
    }) as Ticket;

  it('timed and all-day events, escaped text, CRLF, folded at 75 octets', () => {
    const ics = buildCalendar(
      [
        { id: 't1', t: t({}), boardName: 'Engineering' },
        {
          id: 't2',
          t: t({
            key: 'ENG-2',
            title: 'x'.repeat(120),
            dueAt: Date.UTC(2030, 0, 4, 22),
            dueAllDay: true,
          }),
          boardName: 'Eng',
        },
      ],
      'Asia/Kolkata',
      0,
    );
    expect(ics).toContain('DTSTART:20300102T093000Z\r\n');
    expect(ics).toContain('SUMMARY:ENG-1 · A\\, b\\; c');
    // 22:00 UTC on the 4th is the 5th in Kolkata.
    expect(ics).toContain('DTSTART;VALUE=DATE:20300105');
    expect(ics).toContain('DTEND;VALUE=DATE:20300106');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});
