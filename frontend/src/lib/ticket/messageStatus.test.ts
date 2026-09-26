// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import MessageStatus from './MessageStatus.svelte';

afterEach(cleanup);

describe('MessageStatus (🕓 / ✓ / !)', () => {
  it('shows a clock while sending', () => {
    render(MessageStatus, { props: { mark: 'sending' } });
    expect(screen.getByRole('img', { name: 'Sending' })).toBeTruthy();
  });
  it('shows a tick once sent', () => {
    render(MessageStatus, { props: { mark: 'sent' } });
    expect(screen.getByRole('img', { name: 'Sent' })).toBeTruthy();
  });
  it('shows a red ! with the reason when it failed', () => {
    const { container } = render(MessageStatus, {
      props: { mark: 'failed', error: 'Not allowed' },
    });
    expect(screen.getByRole('img', { name: 'Not sent' }).textContent).toBe('!');
    expect(container.querySelector('[data-mark]')?.getAttribute('title')).toBe(
      'Not sent — Not allowed',
    );
  });
});
