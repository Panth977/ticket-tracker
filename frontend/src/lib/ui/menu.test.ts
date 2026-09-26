// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import MenuHarness from './MenuHarness.test.svelte';

afterEach(cleanup);

describe('Menu', () => {
  it('opens from the trigger and runs the chosen item', async () => {
    const onSelect = vi.fn();
    render(MenuHarness, { props: { onSelect } });
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(trigger);
    await tick();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    await fireEvent.click(items[1]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });
});
