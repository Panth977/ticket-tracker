// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_BRAND_ICONS, AGENT_ICONS } from '@tm/shared';
import Avatar from '$lib/ui/Avatar.svelte';
import { agentIcon, agentIconLabel } from './index';

afterEach(cleanup);

describe('agent icons (agents.html §B)', () => {
  it('every id in the shared list has art; unknown ids have none', () => {
    for (const i of AGENT_ICONS) expect(agentIcon(i.id), i.id).not.toBeNull();
    expect(agentIcon('unicorn')).toBeNull();
    expect(agentIcon(null)).toBeNull();
    expect(agentIcon(undefined)).toBeNull();
    expect(agentIconLabel('claude')).toBe('Claude');
    expect(agentIconLabel('nope')).toBe('');
  });

  it('brand marks render as inline SVG in currentColor, sized like lucide', () => {
    for (const b of AGENT_BRAND_ICONS) {
      const Mark = agentIcon(b.id)!;
      const { container, unmount } = render(Mark, { props: { size: 20 } });
      const svg = container.querySelector('svg')!;
      expect(svg, b.id).not.toBeNull();
      expect(svg.getAttribute('data-brand')).toBe(b.id);
      expect(svg.getAttribute('width')).toBe('20');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(container.innerHTML).toContain('currentColor');
      expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
      unmount();
    }
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
    b.unmount();

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
