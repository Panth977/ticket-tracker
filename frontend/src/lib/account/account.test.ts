import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultChannelMatrix, NOTIFY_EVENTS } from '@tm/shared';
import { clampCrop, coverScale, sourceRect } from './avatar';
import {
  createKeyChecker,
  keyShapeError,
  normalizeKey,
  suggestKey,
  type KeyStatus,
} from './boardKey';
import { addInvites, splitEmails } from './inviteDraft';
import {
  channelSetup,
  columnState,
  deliveryExplanation,
  leadLabel,
  quietHoursSummary,
  toggleCell,
  toggleColumn,
} from './notify';
import { parseAuthorize } from './oauth';
import { describeAgent } from './devices';
import { reauthMethod, signedInRecently } from './reauth';
import { describeScopes, groupsFor, parseScopeParam, scopesFromGroups } from './scopes';
import { expiresInDays, keyState, sortKeys } from './tokens';
import { maskNumber, normalizeCode, toE164 } from './whatsapp';

describe('board keys', () => {
  it('suggests a key from the name', () => {
    expect(suggestKey('Engineering')).toBe('ENG');
    expect(suggestKey('Home repairs')).toBe('HR');
    expect(suggestKey('Panth & co')).toBe('PC');
    expect(suggestKey('The Operations Team')).toBe('OT');
    expect(suggestKey('3 amigos')).toBe('AMI');
    expect(suggestKey('Q')).toBe('QX');
    expect(suggestKey('!!!')).toBe('');
    expect(suggestKey('Customer success and support ops')).toBe('CSSO');
  });
  it('normalises typing', () => {
    expect(normalizeKey('eng-1 x')).toBe('ENG1X');
    expect(normalizeKey('abcdefgh')).toBe('ABCDEF');
  });
  it('explains bad shapes', () => {
    expect(keyShapeError('')).toMatch(/short key/);
    expect(keyShapeError('1AB')).toMatch(/letter/);
    expect(keyShapeError('A')).toMatch(/2/);
    expect(keyShapeError('ENG')).toBeNull();
  });
  it('checks live, debounced, answering only for the latest key', async () => {
    vi.useFakeTimers();
    const seen: [string, KeyStatus][] = [];
    const lookup = vi.fn(async (k: string) => k !== 'ENG');
    const c = createKeyChecker((k, s) => seen.push([k, s]), lookup, 100);
    c.check('EN');
    c.check('ENG');
    await vi.advanceTimersByTimeAsync(150);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual(['ENG', 'taken']);
    c.check('OPS');
    await vi.advanceTimersByTimeAsync(150);
    expect(seen.at(-1)).toEqual(['OPS', 'free']);
    c.check('1');
    expect(seen.at(-1)).toEqual(['1', 'invalid']);
    c.check('');
    expect(seen.at(-1)).toEqual(['', 'idle']);
    vi.useRealTimers();
  });
  it('reports unknown when the lookup fails', async () => {
    vi.useFakeTimers();
    let last: KeyStatus = 'idle';
    const c = createKeyChecker(
      (_, s) => (last = s),
      () => Promise.reject(new Error('offline')),
      10,
    );
    c.check('ENG');
    await vi.advanceTimersByTimeAsync(20);
    expect(last).toBe('unknown');
    vi.useRealTimers();
  });
});

describe('invite drafts', () => {
  it('splits pasted lists', () => {
    expect(splitEmails('a@x.com, b@y.com;<c@z.com>\nd@w.io')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
      'd@w.io',
    ]);
  });
  it('adds, lower-cases, de-dupes, skips self, reports junk', () => {
    const r = addInvites(
      [{ email: 'a@x.com', role: 'editor' }],
      'A@x.com, B@Y.com, me@me.com, nope',
      'viewer',
      'ME@me.com',
    );
    expect(r.list).toEqual([
      { email: 'a@x.com', role: 'editor' },
      { email: 'b@y.com', role: 'viewer' },
    ]);
    expect(r.rejected).toEqual(['nope']);
  });
});

describe('notification settings', () => {
  const m = defaultChannelMatrix();
  it('toggles one cell keeping channel order', () => {
    expect(toggleCell(m, 'comment', 'email', true)).toEqual(['inApp', 'email']);
    expect(toggleCell(m, 'mentioned', 'push', false)).toEqual(['inApp', 'email']);
  });
  it('toggles and summarises a column', () => {
    expect(columnState(m, 'inApp')).toBe('all');
    expect(columnState(m, 'whatsapp')).toBe('none');
    expect(columnState(m, 'email')).toBe('some');
    const patch = toggleColumn(m, 'whatsapp', true);
    expect(Object.keys(patch)).toHaveLength(NOTIFY_EVENTS.length);
    expect(patch.comment).toEqual(['inApp', 'whatsapp']);
  });
  it('greys out channels that are not set up', () => {
    expect(channelSetup({ email: 'a@x.com', whatsapp: null }, 0)).toEqual({
      inApp: true,
      push: false,
      email: true,
      whatsapp: false,
    });
    expect(
      channelSetup({ email: '', whatsapp: { number: '+1555', verifiedAt: 1, optIn: true } }, 2),
    ).toEqual({
      inApp: true,
      push: true,
      email: false,
      whatsapp: true,
    });
    expect(
      channelSetup({ email: 'a', whatsapp: { number: '+1555', verifiedAt: 1, optIn: false } }, 0)
        .whatsapp,
    ).toBe(false);
  });
  it('words quiet hours, lead times and deliveries', () => {
    expect(quietHoursSummary(null)).toBe('Off');
    expect(quietHoursSummary({ start: '22:00', end: '07:00' })).toBe('22:00 – 07:00 (overnight)');
    expect(quietHoursSummary({ start: '12:00', end: '13:00' })).toBe('12:00 – 13:00');
    expect(leadLabel(1440)).toBe('1 day');
    expect(leadLabel(180)).toBe('3 hours');
    expect(deliveryExplanation({ status: 'suppressed', error: 'quiet_hours' })).toMatch(
      /quiet hours/,
    );
    expect(deliveryExplanation({ status: 'failed', error: null })).toMatch(/refused/);
    expect(deliveryExplanation({ status: 'sent', error: null })).toBe('');
  });
});

describe('scopes', () => {
  it('parses a scope param, expanding phase-1 names and ignoring unknown ones', () => {
    expect(parseScopeParam('tickets:create comments:write bogus tickets:create')).toEqual([
      'tickets:create',
      'comments:read',
      'comments:write',
      'files:read',
      'files:write',
    ]);
    expect(parseScopeParam('board:read events:read')).toEqual(['board:read', 'events:read']);
    expect(parseScopeParam(null)).toEqual([]);
  });
  it('groups requested scopes and never widens them', () => {
    const req = parseScopeParam('board:read tickets:read comments:write');
    expect(groupsFor(req).map((g) => g.id)).toEqual(['read', 'comment']);
    expect(scopesFromGroups(['read', 'comment', 'write'], req)).toEqual(req);
    expect(scopesFromGroups(['read'])).toEqual([
      'board:read',
      'members:read',
      'tickets:read',
      'comments:read',
      'files:read',
      'events:read',
    ]);
  });
  it('describes scopes for a list row', () => {
    expect(describeScopes(['tickets:read', 'comments:write'])).toBe('Read tickets · Comment');
  });
});

describe('oauth consent request', () => {
  const base = {
    client_id: 'c1',
    redirect_uri: 'https://claude.ai/cb',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'tickets:read tickets:write',
  };
  const p = (o: Record<string, string>) => parseAuthorize(new URLSearchParams(o));
  it('accepts a well-formed PKCE request', () => {
    const r = p(base);
    expect(r.ok && r.req.scopes).toContain('tickets:move');
    expect(r.ok && r.req.scopes).toContain('tickets:read');
    expect(r.ok && r.req.state).toBe('xyz');
  });
  it('refuses missing pieces and insecure returns', () => {
    expect(p({ ...base, client_id: '' }).ok).toBe(false);
    expect(p({ ...base, redirect_uri: 'http://evil.com/cb' }).ok).toBe(false);
    expect(p({ ...base, redirect_uri: 'http://127.0.0.1:3334/cb' }).ok).toBe(true);
    expect(p({ ...base, code_challenge_method: 'plain' }).ok).toBe(false);
    const { code_challenge: _, ...noPkce } = base;
    expect(p(noPkce).ok).toBe(false);
  });
  it('defaults to read-only when no scope is asked', () => {
    const { scope: _, ...noScope } = base;
    const r = p(noScope);
    expect(r.ok && r.req.scopes.every((s) => s.endsWith(':read'))).toBe(true);
  });
});

describe('avatar crop', () => {
  it('covers the frame and clamps the offset', () => {
    expect(coverScale(1000, 500, 250)).toBe(0.5);
    // 1000×500 at 0.5 → 500×250 in a 250 frame: may move ±125 horizontally, 0 vertically.
    expect(clampCrop({ zoom: 1, x: 999, y: 50 }, 1000, 500, 250)).toEqual({
      zoom: 1,
      x: 125,
      y: 0,
    });
    expect(clampCrop({ zoom: 9, x: 0, y: 0 }, 100, 100, 100).zoom).toBe(4);
  });
  it('maps the frame back to a source square', () => {
    expect(sourceRect({ zoom: 1, x: 0, y: 0 }, 1000, 500, 250)).toEqual({
      sx: 250,
      sy: 0,
      size: 500,
    });
    // Moved fully right → the left edge of the image.
    expect(sourceRect({ zoom: 1, x: 125, y: 0 }, 1000, 500, 250)).toEqual({
      sx: 0,
      sy: 0,
      size: 500,
    });
    // Zoom 2 → a quarter-area square around the centre.
    expect(sourceRect({ zoom: 2, x: 0, y: 0 }, 400, 400, 200)).toEqual({
      sx: 100,
      sy: 100,
      size: 200,
    });
  });
});

describe('tokens', () => {
  const now = 1_000_000;
  it('knows active, expired, revoked', () => {
    expect(keyState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
    expect(keyState({ revokedAt: null, expiresAt: now - 1 }, now)).toBe('expired');
    expect(keyState({ revokedAt: 5, expiresAt: null }, now)).toBe('revoked');
  });
  it('sorts active first, newest first', () => {
    const keys = [
      { id: 'r', revokedAt: 1, expiresAt: null, createdAt: 9 },
      { id: 'a1', revokedAt: null, expiresAt: null, createdAt: 1 },
      { id: 'e', revokedAt: null, expiresAt: 5, createdAt: 8 },
      { id: 'a2', revokedAt: null, expiresAt: null, createdAt: 2 },
    ];
    expect(sortKeys(keys, now).map((k) => k.id)).toEqual(['a2', 'a1', 'e', 'r']);
  });
  it('maps expiry choices', () => {
    expect(expiresInDays('90')).toBe(90);
    expect(expiresInDays('never')).toBeUndefined();
  });
});

describe('whatsapp', () => {
  it('normalises numbers to E.164', () => {
    expect(toE164('+91 98123 45678')).toBe('+919812345678');
    expect(toE164('0044 (20) 7946-0958')).toBe('+442079460958');
    expect(toE164('98123')).toBeNull();
    expect(maskNumber('+919812345678')).toBe('+91 ••••• 45678');
    expect(normalizeCode('12a-34 567')).toBe('123456');
  });
});

describe('re-auth and devices', () => {
  afterEach(() => vi.useRealTimers());
  it('picks the least-friction re-auth', () => {
    expect(reauthMethod(['password', 'google.com'])).toBe('google');
    expect(reauthMethod(['microsoft.com'])).toBe('microsoft');
    expect(reauthMethod(['password'])).toBe('password');
    expect(reauthMethod([])).toBe('emailLink');
  });
  it('knows a recent sign-in', () => {
    const now = Date.parse('2026-09-22T10:00:00Z');
    expect(signedInRecently('Tue, 22 Sep 2026 09:58:00 GMT', now)).toBe(true);
    expect(signedInRecently('Tue, 22 Sep 2026 09:50:00 GMT', now)).toBe(false);
    expect(signedInRecently(undefined, now)).toBe(false);
  });
  it('names a browser', () => {
    expect(
      describeAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
    expect(
      describeAgent('Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0'),
    ).toBe('Firefox on Windows');
  });
});
