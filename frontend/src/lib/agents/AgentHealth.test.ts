// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { agentStatusId, type AgentState, type AgentStatus } from '@tm/shared';
import AgentHealth from './AgentHealth.svelte';

afterEach(cleanup);

const NOW = Date.now();
const MIN = 60_000;

const status = (state: AgentState, over: Partial<AgentStatus> = {}) => ({
  id: agentStatusId('ag_0000000000000001', 't1'),
  agentId: 'ag_0000000000000001',
  ticketId: 't1',
  state,
  message: null,
  progress: null,
  lastBeatAt: NOW,
  startedAt: NOW - 10 * MIN,
  endedAt: null,
  ...over,
});

describe('<AgentHealth>', () => {
  it('draws a pulsing green line while the agent works', () => {
    const { container } = render(AgentHealth, {
      props: { status: status('working', { message: 'Running tests (3/12)' }) },
    });
    const el = container.querySelector('[data-health]')!;
    expect(el.getAttribute('data-health')).toBe('working');
    expect(el.textContent).toContain('Working');
    expect(el.textContent).toContain('Running tests (3/12)');
    expect(container.querySelector('.animate-ping')).not.toBeNull();
    expect(container.querySelector('.bg-success')).not.toBeNull();
  });

  it('turns red and counts the silence when the beats stop', () => {
    const { container } = render(AgentHealth, {
      props: { status: status('working', { lastBeatAt: NOW - 3 * MIN }) },
    });
    const el = container.querySelector('[data-health]')!;
    expect(el.getAttribute('data-health')).toBe('stale');
    expect(el.textContent).toContain('No signal');
    expect(el.textContent).toContain('3 min');
    // Silence does not pulse: nothing is happening.
    expect(container.querySelector('.animate-ping')).toBeNull();
  });

  it('renders nothing at all when the agent has never beaten', () => {
    const { container } = render(AgentHealth, { props: { status: null } });
    expect(container.querySelector('[data-health]')).toBeNull();
  });

  it('dotOnly is a bare dot that still says what it means', () => {
    const { container } = render(AgentHealth, {
      props: { status: status('idle', { message: 'waiting for an answer' }), dotOnly: true },
    });
    const el = container.querySelector('[data-health]')!;
    expect(el.getAttribute('data-health')).toBe('idle');
    expect(el.getAttribute('aria-label')).toBe('Idle · waiting for an answer');
    expect(el.textContent?.trim()).toBe('');
  });

  it('puts the agent name in front when asked', () => {
    const { container } = render(AgentHealth, {
      props: { status: status('error', { message: 'build failed' }), name: 'Builder' },
    });
    const el = container.querySelector('[data-health]')!;
    expect(el.textContent).toContain('Builder');
    expect(el.textContent).toContain('Stopped with an error');
  });
});
