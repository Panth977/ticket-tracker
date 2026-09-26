/**
 * The route guard as a pure function of (auth state, URL) → redirect or null,
 * so it is unit-tested without Firebase. +layout.svelte calls it on every
 * navigation and on every auth/profile change.
 *
 *   signed out            → /login?next=<where you were going>
 *   signed in, not allowed → /welcome/access   (§X: "ask for access")
 *   signed in, no profile → /welcome   (right after sign-up)
 *   signed in on /login   → next ?? /
 *
 * §X (the allow list): this app is private. An account that is signed in but
 * not on the list can reach exactly ONE screen, and every other path — /login
 * included, because signing in again changes nothing — sends it there. The
 * decision is the MIRROR on their own profile (users/{uid}.allowed), the same
 * flag the security rules read; `allowed: false` is the only refusal, since an
 * absent flag means "nothing decided here" (shared/src/schema/user.ts). The
 * server refuses them whatever this function does — the screen exists to say
 * so plainly, not to enforce anything.
 *
 * §T (local first) changes only ONE thing: when the boot painted the app from
 * a remembered session, `pending` is false — the app is already on screen, and
 * the top progress bar is the only sign that auth and the first snapshot are
 * still in flight. Where the app REDIRECTS is untouched: a decision still
 * waits for auth itself, so a remembered session that turns out to be stale
 * lands on /login exactly as it did before.
 */
export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';
/** 'missing' = users/{uid} does not exist (yet); 'new' = first sign-in, Welcome not finished. */
export type ProfileStatus = 'loading' | 'missing' | 'new' | 'ready';

export interface GuardState {
  status: AuthStatus;
  profile: ProfileStatus;
  /** §T — a remembered session is already drawn (auth.fromMemory). */
  remembered?: boolean;
  /**
   * §X — users/{uid}.allowed, straight from the profile: `false` refuses,
   * `true` and absent (and "not loaded yet") do not.
   */
  allowed?: boolean | null;
}

/** Reachable signed out. */
export const PUBLIC_PREFIXES = ['/login'];
/** Reachable signed in without a finished profile. */
export const NO_PROFILE_PREFIXES = ['/welcome', '/invite', '/oauth', '/login'];
/** §X — the ONE screen an account that is not allowed may see. */
export const ASK_FOR_ACCESS = '/welcome/access';

function under(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** Only same-origin absolute paths are honoured as ?next (no open redirect). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (under(next.split(/[?#]/)[0]!, ['/login'])) return '/';
  return next;
}

export function guardRedirect(state: GuardState, url: URL): string | null {
  const path = url.pathname;
  if (state.status === 'loading') return null;
  if (state.status === 'signedOut') {
    if (under(path, PUBLIC_PREFIXES)) return null;
    const here = path + url.search + url.hash;
    return here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`;
  }
  // signed in
  // §X — refused: one screen, and nothing else, /login included (signing in
  // again with the same account would only land back here).
  if (state.allowed === false) return path === ASK_FOR_ACCESS ? null : ASK_FOR_ACCESS;
  // Allowed again (or never refused): that screen is not somewhere to stay.
  if (path === ASK_FOR_ACCESS) return state.profile === 'loading' ? null : '/';
  if (under(path, ['/login'])) return safeNext(url.searchParams.get('next'));
  if (state.profile === 'loading') return null;
  if (
    (state.profile === 'missing' || state.profile === 'new') &&
    !under(path, NO_PROFILE_PREFIXES)
  ) {
    return '/welcome';
  }
  return null;
}

/** true while the guard is still deciding: render a splash, not the page. */
export function guardPending(state: GuardState, url: URL): boolean {
  // §T: never hold a splash over an app that is already painted.
  if (state.remembered && state.status !== 'signedOut') return false;
  if (state.status === 'loading') return true;
  if (
    state.status === 'signedIn' &&
    state.profile === 'loading' &&
    !under(url.pathname, NO_PROFILE_PREFIXES)
  )
    return true;
  return guardRedirect(state, url) !== null;
}
