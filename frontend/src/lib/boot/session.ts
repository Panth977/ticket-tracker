/**
 * The remembered session (docs/plan/agents.html § T).
 *
 * A reload used to hold a skeleton until Firebase Auth had read its own
 * IndexedDB and told us who we are — a quarter of a second in which the device
 * already knew the answer. So the last signed-in principal is mirrored to
 * localStorage on every auth change and read SYNCHRONOUSLY at boot: the shell,
 * the sidebar and the theme render on the first frame, and auth still restores
 * in the background. If it comes back signed OUT, this is dropped and the
 * guard redirects exactly as it did before.
 *
 * NOTHING SENSITIVE LIVES HERE. No ID token, no refresh token, no API key —
 * only what is already visible on the screen it paints (uid, name, photo,
 * theme). The record is a closed shape, built field by field on both write and
 * read, so a future caller cannot smuggle a credential in by accident.
 */
import type { Theme } from '@tm/shared';

/** Versioned: a shape change gets a new key rather than crashing a boot. */
export const SESSION_KEY = 'tm.session.v1';

/** Longer than this and we would rather ask auth than guess. */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const MAX_LEN = 512;

export interface RememberedSession {
  uid: string;
  displayName: string | null;
  photoURL: string | null;
  theme: Theme;
  /** When it was last written (ms since epoch). */
  at: number;
}

export interface SessionInput {
  uid: string;
  displayName?: string | null;
  photoURL?: string | null;
  theme?: Theme | null;
}

function store(): Storage | null {
  try {
    // Private mode / disabled storage: `localStorage` itself can throw.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_LEN) : null;
}

function theme(v: unknown): Theme {
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

/** The remembered principal, or null when there is none we trust. */
export function readSession(now = Date.now()): RememberedSession | null {
  const raw = store()?.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const uid = text(v.uid);
    if (!uid) return null;
    const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0;
    if (at && now - at > SESSION_MAX_AGE_MS) {
      forgetSession();
      return null;
    }
    return {
      uid,
      displayName: text(v.displayName),
      photoURL: text(v.photoURL),
      theme: theme(v.theme),
      at,
    };
  } catch {
    // Someone else's key, a half-written value, a shape from the future:
    // a bad memory must never be able to stop the app from booting.
    forgetSession();
    return null;
  }
}

/**
 * Mirror the signed-in principal. Cheap to call on every auth/profile change:
 * an unchanged record is not written back.
 */
export function rememberSession(input: SessionInput, now = Date.now()): RememberedSession | null {
  const uid = text(input.uid);
  const s = store();
  if (!uid || !s) return null;
  const next: RememberedSession = {
    uid,
    displayName: text(input.displayName),
    photoURL: text(input.photoURL),
    theme: theme(input.theme ?? 'system'),
    at: now,
  };
  const prev = readSession(now);
  if (
    prev &&
    prev.uid === next.uid &&
    prev.displayName === next.displayName &&
    prev.photoURL === next.photoURL &&
    prev.theme === next.theme
  ) {
    return prev;
  }
  try {
    s.setItem(SESSION_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — the app just boots the old way */
  }
  return next;
}

/** Sign-out, or an auth state that disagrees with what we remembered. */
export function forgetSession(): void {
  try {
    store()?.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
