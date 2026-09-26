/**
 * §T — what the remembered session changes about the root layout's gate, and
 * what it must NOT change about where the app redirects.
 *
 * (It lives beside the boot code rather than in guard.test.ts because the
 * behaviour under test is the boot's, not the guard's routing table.)
 */
import { describe, expect, it } from 'vitest';
import { guardPending, guardRedirect, type GuardState } from '../firebase/guard';
import { placeOf } from './track.svelte';

const at = (path: string) => new URL('http://localhost' + path);

describe('the gate with a remembered session', () => {
  const remembered: GuardState = { status: 'loading', profile: 'loading', remembered: true };

  it('a reload paints instead of holding a splash', () => {
    expect(guardPending(remembered, at('/b/ENG/v1'))).toBe(false);
    // Without the memory — a first visit — the splash is still right.
    expect(guardPending({ status: 'loading', profile: 'loading' }, at('/b/ENG/v1'))).toBe(true);
  });

  it('does not flip back to a splash when auth confirms and the profile is still arriving', () => {
    expect(
      guardPending({ status: 'signedIn', profile: 'loading', remembered: true }, at('/b/ENG/v1')),
    ).toBe(false);
    expect(guardPending({ status: 'signedIn', profile: 'loading' }, at('/b/ENG/v1'))).toBe(true);
  });

  it('still redirects exactly as before once auth has spoken', () => {
    // While auth is restoring nothing is decided, remembered or not.
    expect(guardRedirect(remembered, at('/b/ENG/v1'))).toBeNull();
    // Signed out drops the memory (auth.fromMemory goes false with it).
    const out: GuardState = { status: 'signedOut', profile: 'loading' };
    expect(guardRedirect(out, at('/b/ENG/v1'))).toBe('/login?next=%2Fb%2FENG%2Fv1');
    expect(guardPending(out, at('/b/ENG/v1'))).toBe(true);
    // A stale flag can never keep a signed-out person inside the app.
    expect(guardPending({ ...out, remembered: true }, at('/b/ENG/v1'))).toBe(true);
    expect(
      guardRedirect({ status: 'signedIn', profile: 'missing', remembered: true }, at('/me')),
    ).toBe('/welcome');
  });
});

describe('placeOf', () => {
  it('reads the board, the view and the ticket out of a URL', () => {
    expect(placeOf(at('/b/ENG/v7'))).toEqual({ boardKey: 'ENG', viewId: 'v7', ticketKey: null });
    expect(placeOf(at('/b/ENG'))).toEqual({ boardKey: 'ENG', viewId: null, ticketKey: null });
    expect(placeOf(at('/b/ENG/v7?ticket=ENG-42'))).toEqual({
      boardKey: 'ENG',
      viewId: 'v7',
      ticketKey: 'ENG-42',
    });
    expect(placeOf(at('/t/ENG-42'))).toEqual({ boardKey: null, viewId: null, ticketKey: 'ENG-42' });
    expect(placeOf(at('/inbox'))).toEqual({ boardKey: null, viewId: null, ticketKey: null });
  });
});
