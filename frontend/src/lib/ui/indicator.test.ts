// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INDICATOR_ICONS,
  INDICATOR_IMAGE_MAX_BYTES,
  INDICATOR_PATH_RE,
  IndicatorSchema,
  type Indicator,
} from '@tm/shared';

vi.mock('$lib/firebase/client', () => ({ getStorageClient: () => ({}) }));
vi.mock('$lib/firebase/auth.svelte', () => ({
  auth: { user: { uid: 'u1' }, idToken: async () => null },
}));
vi.mock('firebase/storage', () => ({ ref: () => ({}), uploadBytes: async () => ({}) }));

import { INDICATOR_ICON_COMPONENTS, iconLabel } from './indicatorIcons';
import {
  checkIndicatorFile,
  indicatorFileId,
  indicatorFileName,
  indicatorPathFor,
} from './indicatorUpload';
import { EMOJI_CATEGORIES, loadEmojiData, parseEmojiData, searchEmoji } from './emoji';
import IndicatorPicker from './IndicatorPicker.svelte';
import IndicatorView from './Indicator.svelte';

afterEach(cleanup);

describe('indicator icons', () => {
  it('every INDICATOR_ICONS id has a component', () => {
    for (const id of INDICATOR_ICONS) expect(INDICATOR_ICON_COMPONENTS[id], id).toBeTruthy();
    expect(Object.keys(INDICATOR_ICON_COMPONENTS).sort()).toEqual([...INDICATOR_ICONS].sort());
  });
  it('labels icon ids', () => {
    expect(iconLabel('chart-line')).toBe('Chart line');
    expect(iconLabel('gamepad-2')).toBe('Gamepad');
  });
});

describe('emoji data', () => {
  const raw = [
    ['smileys', 'Smileys', '😀|grinning face|smile,happy\n😂|face with tears of joy|laugh'],
    ['nature', 'Nature', '🐶|dog face|puppy,pet\n🌲|evergreen tree|pine,forest'],
  ] as const;
  it('parses categories', () => {
    const d = parseEmojiData(raw);
    expect(d.categories.map((c) => c.id)).toEqual(['smileys', 'nature']);
    expect(d.all).toHaveLength(4);
    expect(d.all[0]).toEqual({
      emoji: '😀',
      name: 'grinning face',
      keywords: ['smile', 'happy'],
      category: 'smileys',
    });
  });
  it('searches by name and keyword, best first', () => {
    const { all } = parseEmojiData(raw);
    expect(searchEmoji(all, '')).toEqual([]);
    expect(searchEmoji(all, 'dog').map((e) => e.emoji)).toEqual(['🐶']);
    expect(searchEmoji(all, 'pet')[0]!.emoji).toBe('🐶');
    expect(searchEmoji(all, 'FACE').map((e) => e.emoji)).toEqual(['😂', '😀', '🐶']);
    expect(searchEmoji(all, 'tree forest').map((e) => e.emoji)).toEqual(['🌲']);
    expect(searchEmoji(all, 'zzz')).toEqual([]);
  });
  it('the bundled set loads, covers every category, and every emoji is valid', async () => {
    const d = await loadEmojiData();
    expect(d.categories.map((c) => c.id)).toEqual(EMOJI_CATEGORIES.map((c) => c.id));
    expect(d.all.length).toBeGreaterThan(500);
    for (const c of d.categories) expect(c.items.length, c.id).toBeGreaterThan(0);
    for (const e of d.all)
      expect(IndicatorSchema.safeParse({ kind: 'emoji', emoji: e.emoji }).success, e.name).toBe(
        true,
      );
    expect(searchEmoji(d.all, 'rocket')[0]!.emoji).toBe('🚀');
  });
});

describe('indicator upload helpers', () => {
  it('checks type and size', () => {
    expect(checkIndicatorFile({ type: 'image/png', size: 10 })).toBeNull();
    expect(checkIndicatorFile({ type: 'image/svg+xml', size: 10 })).toBeNull();
    expect(checkIndicatorFile({ type: 'application/pdf', size: 10 })).toMatch(/PNG/);
    expect(checkIndicatorFile({ type: 'image/png', size: INDICATOR_IMAGE_MAX_BYTES + 1 })).toMatch(
      /1 MB/,
    );
    expect(checkIndicatorFile({ type: 'image/png', size: 0 })).toMatch(/empty/);
  });
  it('sanitizes names', () => {
    expect(indicatorFileName('a/b\\c.png', 'image/png')).toBe('a-b-c.png');
    expect(indicatorFileName('', 'image/webp')).toBe('indicator.webp');
    expect(indicatorFileName('...', 'image/png')).toBe('indicator.png');
    const long = indicatorFileName('x'.repeat(300) + '.jpeg', 'image/jpeg');
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.jpeg')).toBe(true);
  });
  it('makes ids and paths that satisfy INDICATOR_PATH_RE', () => {
    expect(indicatorFileId()).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const p = indicatorPathFor('uid_1', { name: 'logo/final.png', type: 'image/png' }, 'abcdef123');
    expect(p).toBe('indicators/uid_1/abcdef123/logo-final.png');
    expect(
      INDICATOR_PATH_RE.test(indicatorPathFor('u', { name: 'ä ü.gif', type: 'image/gif' })),
    ).toBe(true);
  });
});

describe('IndicatorPicker', () => {
  it('picks a colour, an icon with a tint, an emoji (by search) and an upload', async () => {
    const onchange = vi.fn<(i: Indicator) => void>();
    const upload = vi.fn(async () => 'indicators/u1/abcdef/x.png');
    render(IndicatorPicker, { props: { seed: 'Board', onchange, upload } });
    expect(screen.getByTestId('indicator-picker')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('indicator-color-ef4444'));
    expect(onchange).toHaveBeenLastCalledWith({ kind: 'color', color: '#ef4444' });

    await fireEvent.click(screen.getByTestId('indicator-tab-icon'));
    await fireEvent.click(screen.getByTestId('indicator-icon-rocket'));
    expect(onchange).toHaveBeenLastCalledWith({ kind: 'icon', icon: 'rocket', color: '#ef4444' });
    await fireEvent.click(screen.getByTestId('indicator-tint-22c55e'));
    expect(onchange).toHaveBeenLastCalledWith({ kind: 'icon', icon: 'rocket', color: '#22c55e' });

    await fireEvent.click(screen.getByTestId('indicator-tab-emoji'));
    await waitFor(() => expect(screen.getAllByTestId('indicator-emoji').length).toBeGreaterThan(0));
    await fireEvent.input(screen.getByTestId('indicator-emoji-search'), {
      target: { value: 'rocket' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'rocket' }));
    expect(onchange).toHaveBeenLastCalledWith({ kind: 'emoji', emoji: '🚀' });

    await fireEvent.click(screen.getByTestId('indicator-tab-upload'));
    const input = screen.getByTestId('indicator-upload-input') as HTMLInputElement;
    const bad = new File(['x'], 'x.pdf', { type: 'application/pdf' });
    await fireEvent.change(input, { target: { files: [bad] } });
    expect(screen.getByRole('alert').textContent).toMatch(/PNG/);
    expect(upload).not.toHaveBeenCalled();
    const good = new File(['x'], 'x.png', { type: 'image/png' });
    await fireEvent.change(input, { target: { files: [good] } });
    await waitFor(() =>
      expect(onchange).toHaveBeenLastCalledWith({
        kind: 'image',
        path: 'indicators/u1/abcdef/x.png',
      }),
    );
  });

  it('opens on the tab of the current kind', () => {
    render(IndicatorPicker, { props: { value: { kind: 'emoji', emoji: '🐶' } } });
    expect(screen.getByTestId('indicator-tab-emoji').getAttribute('aria-selected')).toBe('true');
  });
});

describe('Indicator', () => {
  it('draws each kind', () => {
    const { container } = render(IndicatorView, {
      props: { of: { color: 'blue', icon: 'rocket' }, size: 'md' },
    });
    expect(container.querySelector('[data-indicator="icon"]')).toBeTruthy();
    cleanup();
    const r = render(IndicatorView, {
      props: { indicator: { kind: 'emoji', emoji: '🐶' }, label: 'Dog' },
    });
    expect(r.getByRole('img', { name: 'Dog' }).textContent).toContain('🐶');
  });
});
