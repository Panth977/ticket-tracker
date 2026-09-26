/**
 * Light / dark / system. The profile's `theme` is the source of truth; it is
 * mirrored to localStorage so app.html can apply it before first paint.
 */
import type { Theme } from '@tm/shared';

export const THEME_KEY = 'tm.theme';

export function applyTheme(theme: Theme | null | undefined) {
  if (typeof document === 'undefined') return;
  const t = theme ?? 'system';
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode */
  }
}

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch {
    /* ignore */
  }
  return 'system';
}
