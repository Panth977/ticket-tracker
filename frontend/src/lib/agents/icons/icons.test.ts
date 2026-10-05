// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_BRAND_ICONS, AGENT_ICONS } from '@tm/shared';
import Avatar from '$lib/ui/Avatar.svelte';
import BrandMark from './BrandMark.svelte';
import { agentBrand, agentIcon, agentIconLabel } from './index';

afterEach(cleanup);

describe('agent icons (agents.html §B)', () => {
  it('every id in the shared list has art; unknown ids have none', () => {
    for (const i of AGENT_ICONS) {
      expect(agentBrand(i.id) ?? agentIcon(i.id), i.id).not.toBeNull();
      expect(agentBrand(i.id) !== null, i.id).toBe(i.kind === 'brand');
    }
    expect(agentIcon('unicorn')).toBeNull();
    expect(agentIcon(null)).toBeNull();
    expect(agentIcon(undefined)).toBeNull();
    expect(agentIconLabel('claude')).toBe('Claude');
    expect(agentIconLabel('nope')).toBe('');
  });

  it('brand marks render as inline SVG: real colours, or one tint when mono', () => {
    for (const b of AGENT_BRAND_ICONS) {
      const art = agentBrand(b.id)!;
      expect(art.mono.length, b.id).toBeGreaterThan(40);
      expect(art.box.split(' ')).toHaveLength(4);
      for (const c of [...art.fg, ...art.bg]) expect(c, b.id).toMatch(/^#[0-9a-f]{6}$/i);

      const colour = render(BrandMark, { props: { id: b.id, size: 20 } });
      const svg = colour.container.querySelector('svg')!;
      expect(svg, b.id).not.toBeNull();
      expect(svg.getAttribute('data-brand')).toBe(b.id);
      expect(svg.getAttribute('width')).toBe('20');
      expect(svg.getAttribute('viewBox')).toBe(art.bodyBox ?? art.box);
      expect(svg.querySelector('path'), b.id).not.toBeNull();
      expect(colour.container.innerHTML).not.toContain('{id}');
      colour.unmount();

      const mono = render(BrandMark, { props: { id: b.id, size: 20, mono: true } });
      expect(mono.container.querySelectorAll('path')).toHaveLength(1);
      expect(mono.container.innerHTML).toContain('currentColor');
      expect(mono.container.innerHTML).not.toMatch(/#[0-9a-f]{6}/i);
      mono.unmount();
    }
    expect(render(BrandMark, { props: { id: 'bot' } }).container.querySelector('svg')).toBeNull();
  });

  it('two copies of a gradient mark never share a gradient id', () => {
    const a = render(BrandMark, { props: { id: 'gemini' } });
    const b = render(BrandMark, { props: { id: 'gemini' } });
    const ids = [a, b].flatMap((r) =>
      [...r.container.querySelectorAll('linearGradient')].map((g) => g.id),
    );
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the avatar draws picture > icon > initials', () => {
    const a = render(Avatar, {
      props: { src: 'https://img/x.webp', icon: 'claude', name: 'Builder Bot', seed: 'ag_1' },
    });
    expect(a.container.querySelector('img')).not.toBeNull();
    expect(a.container.querySelector('[data-icon]')).toBeNull();
    a.unmount();

    const b = render(Avatar, { props: { icon: 'claude', name: 'Builder Bot', seed: 'ag_1' } });
    expect(b.container.querySelector('img')).toBeNull();
    expect(b.container.querySelector('[data-icon="claude"] svg')).not.toBeNull();
    expect(b.container.textContent?.trim()).toBe('');
    // the brand's own tile and colours by default; the principal's colour when tinted
    const tile = (r: typeof b) =>
      (r.container.firstElementChild as HTMLElement).getAttribute('style');
    expect(tile(b)).toContain('light-dark(');
    expect(tile(b)).toContain('rgb(217, 119, 87)');
    b.unmount();
    const t = render(Avatar, {
      props: { icon: 'claude', name: 'Builder Bot', seed: 'ag_1', tint: true },
    });
    expect(tile(t)).not.toContain('light-dark(');
    expect(t.container.innerHTML).not.toContain('#D97757');
    t.unmount();

    const c = render(Avatar, { props: { icon: 'terminal', name: 'Builder Bot', seed: 'ag_1' } });
    expect(c.container.querySelector('[data-icon="terminal"] svg')).not.toBeNull();
    c.unmount();

    const d = render(Avatar, { props: { icon: 'unicorn', name: 'Builder Bot', seed: 'ag_1' } });
    expect(d.container.querySelector('[data-icon]')).toBeNull();
    expect(d.container.textContent?.trim()).toBe('BB');
    d.unmount();

    const e = render(Avatar, { props: { icon: null, name: 'Builder Bot', seed: 'ag_1' } });
    expect(e.container.textContent?.trim()).toBe('BB');
  });
});
