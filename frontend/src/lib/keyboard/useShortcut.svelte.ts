/**
 * Bind a shortcut for the lifetime of the calling component:
 *   useShortcut('j', () => move(1), { description: 'Next' });
 * Call during component initialisation.
 */
import { shortcuts, type BindOptions, type Handler } from './shortcuts';

export function useShortcut(combo: string, handler: Handler, opts?: BindOptions) {
  $effect(() => shortcuts.bind(combo, (e) => handler(e), opts));
}
