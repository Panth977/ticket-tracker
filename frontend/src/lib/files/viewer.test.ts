// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTML_SANDBOX } from '@tm/shared';

// lucide-svelte ships Svelte 4 components; this project compiles everything in runes mode.
vi.mock('lucide-svelte', async () => {
  const Stub = (await import('../account/IconStub.test.svelte')).default;
  return new Proxy({ __esModule: true } as Record<string, unknown>, {
    get: (t, k) =>
      k in t ? t[k as string] : typeof k === 'string' && /^[A-Z]/.test(k) ? Stub : undefined,
    has: (t, k) => k in t || (typeof k === 'string' && /^[A-Z]/.test(k)),
  });
});
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/ui/toast.svelte', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const TEXTS: Record<string, string> = {
  'p/r.html': '<!doctype html><h1>Report</h1><script>document.title="x"</script>',
  'p/plan.md':
    '# Plan\n\n## One\n\ntext\n\n## Two\n\n## Three\n\n<script>alert(1)</script>\n\n- [x] done',
  'p/d.csv': 'a,b\n1,2\n',
};
vi.mock('./source', () => ({
  fileUrl: vi.fn(async (p: string) => `https://files.test/${p}`),
  fileText: vi.fn(async (f: { path: string }) => ({ text: TEXTS[f.path] ?? '', truncated: false })),
  downloadFile: vi.fn(async () => true),
}));

const { default: HtmlFrame } = await import('./HtmlFrame.svelte');
const { default: FileCard } = await import('./FileCard.svelte');
const { default: FileContent } = await import('./FileContent.svelte');
const { default: FileViewer } = await import('./FileViewer.svelte');

afterEach(() => cleanup());

const file = (name: string, mime = '', path = `p/${name}`) => ({
  id: name,
  name,
  mime,
  size: 1234,
  path,
});

function assertSandboxed(frame: HTMLIFrameElement) {
  const sandbox = frame.getAttribute('sandbox') ?? '';
  expect(frame.hasAttribute('sandbox')).toBe(true);
  expect(sandbox).toBe(HTML_SANDBOX);
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  expect(sandbox).not.toContain('allow-top-navigation');
  // srcdoc, never a URL on the app's origin.
  expect(frame.hasAttribute('srcdoc')).toBe(true);
  expect(frame.hasAttribute('src')).toBe(false);
}

describe('HTML sandbox', () => {
  it('HtmlFrame: scripts yes, same-origin never, srcdoc', () => {
    const { container } = render(HtmlFrame, { html: '<p>hi</p>', title: 'Doc' });
    const frame = container.querySelector('iframe')!;
    assertSandboxed(frame);
    expect(frame.getAttribute('srcdoc')).toBe('<p>hi</p>');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('the HTML card preview is sandboxed the same way', async () => {
    const { container } = render(FileCard, { file: file('r.html', 'text/html') });
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    assertSandboxed(container.querySelector('iframe')!);
  });

  it('the HTML viewer is sandboxed the same way', async () => {
    const { container } = render(FileContent, { file: file('r.html') });
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const frame = container.querySelector('iframe')!;
    assertSandboxed(frame);
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Report</h1>');
  });
});

describe('cards by kind', () => {
  it('image → thumbnail', async () => {
    const { container } = render(FileCard, { file: file('a.png', 'image/png') });
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://files.test/p/a.png',
      ),
    );
    expect(container.firstElementChild?.getAttribute('data-kind')).toBe('image');
  });
  it('audio → an inline player', async () => {
    const { container } = render(FileCard, { file: file('s.mp3', 'audio/mpeg') });
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
  });
  it('markdown → title from the first heading, excerpt rendered', async () => {
    const { container } = render(FileCard, { file: file('plan.md') });
    await waitFor(() => expect(screen.getByTitle('plan.md').textContent).toBe('Plan'));
    expect(container.querySelector('.tm-md h1')?.textContent).toBe('Plan');
  });
  it('other → icon card, opens on click', async () => {
    const onopen = vi.fn();
    const { container } = render(FileCard, {
      file: file('x.bin', 'application/octet-stream'),
      onopen,
      href: '/f/B/B-1/x',
    });
    expect(container.querySelector('iframe, img, video, audio')).toBeNull();
    (screen.getByLabelText('Open x.bin') as HTMLButtonElement).click();
    expect(onopen).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Open x.bin in a new tab').getAttribute('href')).toBe(
      '/f/B/B-1/x',
    );
  });
});

describe('viewer', () => {
  it('markdown: sanitised, with a table of contents', async () => {
    const { container } = render(FileContent, { file: file('plan.md') });
    await waitFor(() => expect(container.querySelector('.tm-md')).not.toBeNull());
    expect(container.querySelector('.tm-md script')).toBeNull();
    expect(container.innerHTML).toContain('&lt;script&gt;');
    expect(screen.getByLabelText('Table of contents').textContent).toContain('Three');
    expect(container.querySelector('#md-two')).not.toBeNull();
    expect(screen.getByRole('radio', { name: /Source/ })).toBeTruthy();
  });

  it('csv: a table', async () => {
    const { container } = render(FileContent, { file: file('d.csv') });
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    expect([...container.querySelectorAll('th')].map((x) => x.textContent)).toEqual([
      '#',
      'a',
      'b',
    ]);
  });

  it('prev / next across the files and Esc closes', async () => {
    const files = [file('a.png', 'image/png'), file('plan.md'), file('d.csv')];
    const onclose = vi.fn();
    render(FileViewer, { files, current: 'plan.md', onclose });
    expect(screen.getByText(/2 of 3/)).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'd.csv' })).toBeTruthy());
    expect((screen.getAllByLabelText('Next file')[0] as HTMLButtonElement).disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onclose).toHaveBeenCalledOnce();
  });
});
