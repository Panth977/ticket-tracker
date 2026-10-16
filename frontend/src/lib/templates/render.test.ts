// @vitest-environment jsdom
/** The render engine (templates.html §B3): patching keeps nodes, focus and what you typed. */
import { describe, expect, it } from 'vitest';
import { createRenderer, safeHref, safeImage, safeStyle } from './render';
import type { VElement, VSlot } from './protocol';

const el = (t: string, p: Record<string, unknown> = {}, c?: VSlot[], k?: string): VElement => ({
  t,
  p,
  ...(c ? { c } : {}),
  ...(k !== undefined ? { k } : {}),
});

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const sent: { h: string; args: unknown[] }[] = [];
  let seq = 0;
  const r = createRenderer(root, {
    dispatch: (h, args) => {
      sent.push({ h, args });
      return ++seq;
    },
  });
  return { root, r, sent };
}

describe('template renderer', () => {
  it('keeps an input (and its focus) when a field appears before it', () => {
    const { root, r } = setup();
    const tree = (on: boolean): VSlot[] => [
      el('box', { dir: 'col' }, [
        on ? el('select', { label: 'Severity', options: ['a', 'b'] }) : null,
        el('input', { label: 'Title', value: '' }),
      ]),
    ];
    r.update(tree(false), 0);
    const input = root.querySelector('input')!;
    input.focus();
    expect(document.activeElement).toBe(input);
    r.update(tree(true), 0);
    expect(root.querySelector('select')).toBeTruthy();
    expect(root.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it('never undoes typing: a value is written only once the worker saw the last key', () => {
    const { root, r, sent } = setup();
    const tree = (value: string): VSlot[] => [el('input', { value, onInput: { $h: '1:0' } })];
    r.update(tree(''), 0);
    const input = root.querySelector('input')!;
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    input.value = 'ab';
    input.dispatchEvent(new Event('input'));
    expect(sent.map((s) => s.args[0])).toEqual(['a', 'ab']);
    // The worker answers the FIRST key (ack 1) with value 'a' — stale; the DOM keeps 'ab'.
    r.update(tree('a'), 1);
    expect(input.value).toBe('ab');
    // Caught up (ack 2): its value is the truth again — even when the template changed it.
    r.update(tree('AB'), 2);
    expect(input.value).toBe('AB');
  });

  it('keyed lists move rows instead of rebuilding them', () => {
    const { root, r } = setup();
    const rows = (keys: string[]): VSlot[] => [
      el(
        'box',
        {},
        keys.map((k) => el('text', {}, [k], k)),
      ),
    ];
    r.update(rows(['a', 'b', 'c']), 0);
    const b = [...root.querySelectorAll('span')].find((s) => s.textContent === 'b')!;
    r.update(rows(['c', 'b']), 0);
    const spans = [...root.querySelectorAll('span')];
    expect(spans.map((s) => s.textContent)).toEqual(['c', 'b']);
    expect(spans[1]).toBe(b);
  });

  it('shows field errors by input name, and clears them', () => {
    const { root, r } = setup();
    r.update([el('textarea', { label: 'Steps', name: 'steps' })], 0);
    r.setErrors({ steps: 'Required' });
    expect(root.textContent).toContain('Required');
    expect(root.querySelector('textarea')!.getAttribute('aria-invalid')).toBe('true');
    r.setErrors({});
    expect(root.textContent).not.toContain('Required');
  });

  it('select, checkbox and button send their events', () => {
    const { root, r, sent } = setup();
    r.update(
      [
        el('select', {
          options: [{ value: 'x', label: 'X' }, 'y'],
          value: 'y',
          onChange: { $h: 's' },
        }),
        el('checkbox', { label: 'Ok', checked: false, onChange: { $h: 'c' } }),
        el('button', { label: 'Go', onClick: { $h: 'b' } }),
      ],
      0,
    );
    const sel = root.querySelector('select')!;
    expect(sel.value).toBe('y');
    sel.value = 'x';
    sel.dispatchEvent(new Event('change'));
    const box = root.querySelector('input[type=checkbox]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    root.querySelector('button')!.click();
    expect(sent.map((s) => [s.h, s.args[0]])).toEqual([
      ['s', 'x'],
      ['c', true],
      ['b', undefined],
    ]);
  });

  it('a static tree (cards) draws inputs disabled and sends nothing', () => {
    const root = document.createElement('div');
    const r = createRenderer(root, {});
    r.update([el('button', { label: 'Go', onClick: { $h: 'b' } })], 0);
    expect(root.querySelector('button')!.disabled).toBe(true);
  });

  it('markdown is sanitised; links and images are fenced', () => {
    const { root, r } = setup();
    r.update(
      [
        el('markdown', { md: '**hi** <img src=x onerror=alert(1)> [x](javascript:alert(1))' }),
        el('link', { label: 'bad', href: 'javascript:alert(1)' }),
        el('image', { src: 'http://insecure.example/x.png' }),
      ],
      0,
    );
    expect(root.querySelector('[onerror]')).toBeNull();
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
    expect(root.querySelector('strong')!.textContent).toBe('hi');
    expect(root.querySelector('a:not([href])')!.textContent).toBe('bad');
    expect(root.querySelector('img')!.getAttribute('src')).toBeNull();
  });

  it('the style, href and image fences', () => {
    expect(
      safeStyle({ color: 'red', backgroundImage: 'url(https://x)', marginTop: 4, '--x': '1' }),
    ).toEqual({
      color: 'red',
      'margin-top': '4',
      '--x': '1',
    });
    expect(safeHref('https://a.b')).toBe('https://a.b');
    expect(safeHref('/t/ENG-1')).toBe('/t/ENG-1');
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeImage('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeImage('data:image/svg+xml;base64,AAAA')).toBeNull();
  });
});
