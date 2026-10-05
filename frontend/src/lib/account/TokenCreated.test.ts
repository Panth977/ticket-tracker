// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

// indicators.html: the entity mark pulls in lucide icons this test does not stub.
vi.mock('$lib/ui/indicatorIcons', () => ({
  INDICATOR_ICON_COMPONENTS: {},
  iconLabel: (s: string) => s,
}));
vi.mock('$lib/ui/Indicator.svelte', async () => ({
  default: (await import('./IconStub.test.svelte')).default,
}));
vi.mock('lucide-svelte', async () => {
  const Stub = (await import('./IconStub.test.svelte')).default;
  return Object.fromEntries(['Check', 'Copy', 'TriangleAlert', 'X'].map((n) => [n, Stub]));
});
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/ui/toast.svelte', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { default: TokenCreated } = await import('./TokenCreated.svelte');

afterEach(cleanup);

describe('TokenCreated', () => {
  const props = {
    token: 'tm_live_abcdef123456',
    apiBase: 'https://tm.example.com',
    name: 'orch eng',
    actsAs: 'Builder (agent)',
    boardName: 'Engineering',
  };

  it('shows the token and a ready MCP config', () => {
    const { container } = render(TokenCreated, props);
    expect(container.textContent).toContain('tm_live_abcdef123456');
    expect(container.textContent).toContain('Builder (agent)');
    const pre = [...container.querySelectorAll('pre')].map((p) => p.textContent ?? '');
    const json = pre.find((t) => t.includes('mcpServers'));
    expect(json).toBeTruthy();
    const cfg = JSON.parse(json!);
    expect(cfg.mcpServers['taskmanager-orch-eng']).toEqual({
      type: 'http',
      url: 'https://tm.example.com/mcp',
      headers: { Authorization: 'Bearer tm_live_abcdef123456' },
    });
  });

  it('switches to curl examples and copies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(TokenCreated, props);
    await fireEvent.click(screen.getByRole('tab', { name: 'curl' }));
    expect(container.textContent).toContain('https://tm.example.com/v1/me');
    await fireEvent.click(screen.getAllByRole('button', { name: /^Copy/ })[0]!);
    expect(writeText).toHaveBeenCalledWith('tm_live_abcdef123456');
  });

  // §AA1/§AA5: the agent page's "shown once" — no board, and the TM_TOKEN line.
  it('shows an agent token with its TM_TOKEN line and no board', () => {
    const { container } = render(TokenCreated, {
      token: 'tm_live_abcdef123456',
      apiBase: 'https://tm.example.com',
      name: 'Builder',
      actsAs: 'Builder (agent)',
      kind: 'agent',
    });
    const pre = [...container.querySelectorAll('pre')].map((p) => p.textContent ?? '');
    expect(pre).toContain('TM_TOKEN=tm_live_abcdef123456');
    expect(container.textContent).toContain('every board and artifact it is on');
    expect(container.textContent).toContain('Builder (agent)');
  });
});
