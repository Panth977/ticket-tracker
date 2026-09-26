/**
 * `use:copyCode` — one delegated click handler for every code block's Copy
 * button inside rendered Markdown / rich text (the buttons are plain HTML from
 * renderMarkdown, so they can't carry Svelte handlers).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function copyCode(node: HTMLElement) {
  const onClick = (e: MouseEvent) => {
    const btn = (e.target as Element | null)?.closest?.('button[data-copy]');
    if (!btn || !node.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    const code = btn.parentElement?.querySelector('pre')?.textContent ?? '';
    void copyText(code).then((ok) => {
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      btn.setAttribute('data-copied', '');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.removeAttribute('data-copied');
      }, 1500);
    });
  };
  node.addEventListener('click', onClick);
  return { destroy: () => node.removeEventListener('click', onClick) };
}
