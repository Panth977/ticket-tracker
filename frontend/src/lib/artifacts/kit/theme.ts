/**
 * The app's look, handed to kit artifacts: the kit's UI tokens (--sbx-*) set
 * from the app's own (--tm-*), and the resolved light/dark mode. Artifacts
 * using the kit's components then look like the rest of the app, and follow
 * its theme switch live.
 */
import type { Theme } from '@panth977/sandbox/protocol';

/** --sbx-<name> ← --tm-<name> */
const SHARED = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'line',
  'line-strong',
  'text',
  'muted',
  'subtle',
  'accent',
  'accent-hover',
  'accent-fg',
  'accent-soft',
  'danger',
  'danger-soft',
  'success',
  'success-soft',
  'warning',
  'warning-soft',
  'overlay',
  'shadow',
] as const;

/** The app's resolved mode right now. */
export function appMode(doc: Document = document): 'light' | 'dark' {
  const forced = doc.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** The theme to give an artifact. */
export function appTheme(doc: Document = document): Theme {
  const style = getComputedStyle(doc.documentElement);
  const vars: Record<string, string> = {};
  for (const name of SHARED) {
    const v = style.getPropertyValue(`--tm-${name}`).trim();
    if (v) vars[`--sbx-${name}`] = v;
  }
  return { mode: appMode(doc), vars };
}

/** Calls `cb` when the app's theme changes (the switch, or the system's). Returns a stop function. */
export function onAppTheme(cb: (t: Theme) => void, doc: Document = document): () => void {
  const fire = () => queueMicrotask(() => cb(appTheme(doc)));
  const mo = new MutationObserver(fire);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  mq?.addEventListener('change', fire);
  return () => {
    mo.disconnect();
    mq?.removeEventListener('change', fire);
  };
}
