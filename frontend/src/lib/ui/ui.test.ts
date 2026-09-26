// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import Badge from './Badge.svelte';
import Button from './Button.svelte';
import Kbd from './Kbd.svelte';
import Tabs from './Tabs.svelte';
import EmptyState from './EmptyState.svelte';
import Avatar from './Avatar.svelte';

afterEach(cleanup);

describe('ui components', () => {
  it('Button fires clicks and disables while loading', async () => {
    const onclick = vi.fn();
    const { rerender } = render(Button, { props: { onclick, variant: 'primary' } });
    await fireEvent.click(screen.getByRole('button'));
    expect(onclick).toHaveBeenCalledTimes(1);
    await rerender({ onclick, loading: true });
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
  it('Button with href renders a link', () => {
    render(Button, { props: { href: '/new-board' } });
    expect(screen.getByRole('link').getAttribute('href')).toBe('/new-board');
  });
  it('Badge caps counts', () => {
    render(Badge, { props: { count: 150 } });
    expect(screen.getByText('99+')).toBeTruthy();
  });
  it('Kbd renders keys', () => {
    const { container } = render(Kbd, { props: { keys: 'mod+k' } });
    expect(container.querySelectorAll('kbd').length).toBe(2);
  });
  it('Tabs move with arrow keys', async () => {
    const onchange = vi.fn();
    render(Tabs, {
      props: {
        items: [
          { id: 'a', label: 'Thread' },
          { id: 'b', label: 'Activity' },
        ],
        value: 'a',
        onchange,
      },
    });
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    await tick();
    expect(onchange).toHaveBeenCalledWith('b');
    expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true');
  });
  it('EmptyState shows title and description', () => {
    render(EmptyState, { props: { title: 'Nothing here', description: 'Create one' } });
    expect(screen.getByRole('heading').textContent).toBe('Nothing here');
  });
  it('Avatar falls back to initials', () => {
    render(Avatar, { props: { name: 'Panth Patel', seed: 'u1' } });
    expect(screen.getByRole('img').textContent?.trim()).toBe('PP');
  });
  it('Avatar draws an agent icon over initials, and a picture over both', () => {
    const { container, rerender } = render(Avatar, {
      props: { name: 'Builder', seed: 'ag_1', icon: 'bot' },
    });
    expect(container.querySelector('[data-icon="bot"] svg')).not.toBeNull();
    expect(screen.getByRole('img').textContent?.trim()).toBe('');
    void rerender({ name: 'Builder', seed: 'ag_1', icon: 'bot', src: 'https://img/a.webp' });
    expect(container.querySelector('img')).not.toBeNull();
  });
});
