import { describe, expect, it } from 'vitest';
import { guardPending, guardRedirect, safeNext } from './guard';

const u = (p: string) => new URL(p, 'http://x');

describe('guardRedirect', () => {
  it('waits while auth is loading', () => {
    expect(guardRedirect({ status: 'loading', profile: 'loading' }, u('/inbox'))).toBeNull();
    expect(guardPending({ status: 'loading', profile: 'loading' }, u('/inbox'))).toBe(true);
  });
  it('sends signed-out people to /login with next', () => {
    expect(
      guardRedirect({ status: 'signedOut', profile: 'loading' }, u('/b/ENG/v1?ticket=ENG-4')),
    ).toBe('/login?next=%2Fb%2FENG%2Fv1%3Fticket%3DENG-4');
    expect(guardRedirect({ status: 'signedOut', profile: 'loading' }, u('/'))).toBe('/login');
    expect(guardRedirect({ status: 'signedOut', profile: 'loading' }, u('/login'))).toBeNull();
  });
  it('sends a signed-in person away from /login', () => {
    expect(guardRedirect({ status: 'signedIn', profile: 'ready' }, u('/login?next=%2Finbox'))).toBe(
      '/inbox',
    );
    expect(
      guardRedirect({ status: 'signedIn', profile: 'ready' }, u('/login?next=https://evil.com')),
    ).toBe('/');
  });
  it('sends a person with no profile to /welcome, except invite/oauth', () => {
    expect(guardRedirect({ status: 'signedIn', profile: 'missing' }, u('/inbox'))).toBe('/welcome');
    expect(guardRedirect({ status: 'signedIn', profile: 'new' }, u('/'))).toBe('/welcome');
    expect(guardRedirect({ status: 'signedIn', profile: 'new' }, u('/welcome'))).toBeNull();
    expect(
      guardRedirect({ status: 'signedIn', profile: 'missing' }, u('/invite/abc.tok')),
    ).toBeNull();
    expect(guardRedirect({ status: 'signedIn', profile: 'ready' }, u('/inbox'))).toBeNull();
  });
  // §X — the allow list: one screen, and nothing else.
  it('sends an account that is not allowed to /welcome/access, from anywhere', () => {
    const refused = { status: 'signedIn', profile: 'ready', allowed: false } as const;
    expect(guardRedirect(refused, u('/'))).toBe('/welcome/access');
    expect(guardRedirect(refused, u('/b/ENG'))).toBe('/welcome/access');
    expect(guardRedirect(refused, u('/account/tokens'))).toBe('/welcome/access');
    // Signing in again changes nothing, so /login is not a way out either.
    expect(guardRedirect(refused, u('/login?next=%2Finbox'))).toBe('/welcome/access');
    expect(guardRedirect(refused, u('/welcome/access'))).toBeNull();
  });
  it('lets an allowed account (or one nothing was decided about) off that screen', () => {
    expect(
      guardRedirect({ status: 'signedIn', profile: 'ready', allowed: true }, u('/welcome/access')),
    ).toBe('/');
    expect(guardRedirect({ status: 'signedIn', profile: 'ready' }, u('/welcome/access'))).toBe('/');
    expect(
      guardRedirect({ status: 'signedIn', profile: 'ready', allowed: true }, u('/inbox')),
    ).toBeNull();
    // Nothing is decided while the profile is still arriving.
    expect(
      guardRedirect({ status: 'signedIn', profile: 'loading', allowed: null }, u('/inbox')),
    ).toBeNull();
  });
  it('holds the page while the profile loads', () => {
    expect(guardPending({ status: 'signedIn', profile: 'loading' }, u('/inbox'))).toBe(true);
    expect(guardPending({ status: 'signedIn', profile: 'ready' }, u('/inbox'))).toBe(false);
  });
});

describe('safeNext', () => {
  it('rejects protocol-relative and foreign targets', () => {
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('/\\evil.com')).toBe('/');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext('/me')).toBe('/me');
  });
});
