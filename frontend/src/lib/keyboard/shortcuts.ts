/**
 * The keyboard shortcut service (architecture › Keyboard):
 *   C new ticket · / search · ⌘K palette · j/k move in lists · e archive (inbox) · ⌘↵ send
 *
 * One window listener; bindings form a stack — the most recently registered
 * binding for a combo runs first (so a dialog or drawer can take over 'e' or
 * 'j' while it is open) and may return `false` to let older ones handle it.
 * Plain-key shortcuts are ignored while typing in an input / textarea /
 * contenteditable unless the binding says `inInputs: true` (⌘K and ⌘↵ do).
 *
 *   const off = shortcuts.bind('c', () => openQuickAdd(), { description: 'New ticket' });
 *   // in a component: useShortcut('j', next)   (from ./useShortcut.svelte)
 *
 * Combos: 'c', '/', 'j', 'mod+k', 'mod+enter', 'shift+enter', 'escape', 'alt+n'
 * — `mod` is ⌘ on Mac and Ctrl elsewhere.
 */
import { isMac } from '$lib/ui/keys';

export type Handler = (e: KeyboardEvent) => void | boolean;

export interface BindOptions {
  description?: string;
  /** Fire even while focus is in a text field. */
  inInputs?: boolean;
  /** Group name for the shortcuts help list. */
  group?: string;
}

interface Binding extends BindOptions {
  combo: string;
  handler: Handler;
  id: number;
}

/** Canonical combo: modifiers in fixed order, key lower-cased. */
export function normalizeCombo(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim());
  const key = parts.pop() ?? '';
  const mods = new Set(
    parts.map((m) => (m === 'cmd' || m === 'meta' || m === 'ctrl' || m === 'control' ? 'mod' : m)),
  );
  return [
    ...['mod', 'alt', 'shift'].filter((m) => mods.has(m)),
    key === 'return' ? 'enter' : key === 'esc' ? 'escape' : key,
  ].join('+');
}

/** The combo a KeyboardEvent represents. */
export function eventCombo(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac = isMac(),
): string {
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (e.altKey) mods.push('alt');
  // Shift is part of the character for symbols ('?', '/'): only count it for letters and named keys.
  if (e.shiftKey && (key.length > 1 || /[a-z]/.test(key))) mods.push('shift');
  return [...mods, key].join('+');
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== 'string') return false;
  const el = t as HTMLElement;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      type,
    );
  }
  return el.isContentEditable;
}

export function createShortcuts(mac = isMac()) {
  let bindings: Binding[] = [];
  let next = 1;

  function bind(combo: string, handler: Handler, opts: BindOptions = {}): () => void {
    const b: Binding = { ...opts, combo: normalizeCombo(combo), handler, id: next++ };
    bindings = [...bindings, b];
    return () => {
      bindings = bindings.filter((x) => x.id !== b.id);
    };
  }

  /** Returns true when a binding handled the event. */
  function dispatch(e: KeyboardEvent): boolean {
    if (e.defaultPrevented || e.isComposing) return false;
    const combo = eventCombo(e, mac);
    const typing = isTypingTarget(e.target);
    for (let i = bindings.length - 1; i >= 0; i--) {
      const b = bindings[i]!;
      if (b.combo !== combo) continue;
      if (typing && !b.inInputs) continue;
      if (b.handler(e) === false) continue;
      e.preventDefault();
      return true;
    }
    return false;
  }

  function install(target: Window = window): () => void {
    const h = (e: KeyboardEvent) => void dispatch(e);
    target.addEventListener('keydown', h);
    return () => target.removeEventListener('keydown', h);
  }

  /** Bindings with a description, newest per combo (for a help list). */
  function list(): { combo: string; description: string; group?: string }[] {
    const seen = new Set<string>();
    const out: { combo: string; description: string; group?: string }[] = [];
    for (let i = bindings.length - 1; i >= 0; i--) {
      const b = bindings[i]!;
      if (!b.description || seen.has(b.combo)) continue;
      seen.add(b.combo);
      out.push({ combo: b.combo, description: b.description, group: b.group });
    }
    return out.reverse();
  }

  return { bind, dispatch, install, list };
}

/** The app-wide instance (installed by the root layout). */
export const shortcuts = createShortcuts();
