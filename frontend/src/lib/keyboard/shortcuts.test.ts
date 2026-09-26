import { describe, expect, it, vi } from 'vitest';
import { createShortcuts, eventCombo, normalizeCombo } from './shortcuts';

const ev = (key: string, o: Partial<KeyboardEvent> = {}, target: unknown = null) =>
  ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    target,
    preventDefault: vi.fn(),
    ...o,
  }) as unknown as KeyboardEvent;

describe('combos', () => {
  it('normalizes', () => {
    expect(normalizeCombo('Cmd+K')).toBe('mod+k');
    expect(normalizeCombo('shift+mod+Return')).toBe('mod+shift+enter');
  });
  it('reads events', () => {
    expect(eventCombo(ev('k', { metaKey: true }), true)).toBe('mod+k');
    expect(eventCombo(ev('k', { ctrlKey: true }), false)).toBe('mod+k');
    expect(eventCombo(ev('?', { shiftKey: true }), true)).toBe('?');
    expect(eventCombo(ev('Enter', { metaKey: true }), true)).toBe('mod+enter');
  });
});

describe('createShortcuts', () => {
  it('newest binding wins, false falls through', () => {
    const s = createShortcuts(true);
    const a = vi.fn();
    const b = vi.fn(() => false);
    s.bind('e', a);
    const off = s.bind('e', b);
    expect(s.dispatch(ev('e'))).toBe(true);
    expect(b).toHaveBeenCalled();
    expect(a).toHaveBeenCalled();
    off();
  });
  it('ignores plain keys while typing, unless inInputs', () => {
    const s = createShortcuts(true);
    const c = vi.fn();
    const k = vi.fn();
    s.bind('c', c);
    s.bind('mod+k', k, { inInputs: true });
    const input = { tagName: 'INPUT', type: 'text', isContentEditable: false };
    expect(s.dispatch(ev('c', {}, input))).toBe(false);
    expect(s.dispatch(ev('k', { metaKey: true }, input))).toBe(true);
    expect(c).not.toHaveBeenCalled();
    expect(k).toHaveBeenCalled();
  });
  it('lists described bindings', () => {
    const s = createShortcuts(true);
    s.bind('c', () => {}, { description: 'New ticket' });
    expect(s.list()).toEqual([{ combo: 'c', description: 'New ticket', group: undefined }]);
  });
});
