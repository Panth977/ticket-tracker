<!--
  A TSVG vector video (.tsvg / .tsvgz), played in a sandboxed frame (frame.ts):
    sandbox="allow-scripts" — NEVER allow-same-origin; srcdoc; CSP: blob:/data: only
  The page reads the file's bytes (the caller passes them) and posts them in.
  `poster`: a still frame for a file card, no controls. The engine (~40 kB of
  text) is loaded only when the first TSVG is shown.
-->
<script lang="ts">
  import type { FrameMessage } from './frame';

  /** Scripts run; nothing else. No same-origin, forms, popups or top navigation. */
  const TSVG_SANDBOX = 'allow-scripts';
  /** The player's own fullscreen button, and sound after a click in the frame. */
  const TSVG_ALLOW = 'fullscreen; autoplay';

  interface Props {
    bytes: ArrayBuffer;
    title: string;
    poster?: boolean;
    class?: string;
    /** The video loaded (its length in seconds). */
    onloaded?: (duration: number) => void;
    onerror?: (message: string) => void;
  }
  let { bytes, title, poster = false, class: cls = '', onloaded, onerror }: Props = $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  let srcdoc = $state<string | null>(null);
  $effect(() => {
    const p = poster;
    let alive = true;
    void import('./frame').then((m) => alive && (srcdoc = m.tsvgFrameHtml(p)));
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    const f = frame;
    const b = bytes;
    if (!f) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== f.contentWindow) return;
      const m = e.data as FrameMessage | null;
      // The frame is an opaque origin, so '*' is the only target that reaches it.
      if (m?.type === 'tsvg:ready')
        f.contentWindow?.postMessage({ type: 'tsvg:load', bytes: b.slice(0) }, '*');
      else if (m?.type === 'tsvg:loaded') onloaded?.(m.duration);
      else if (m?.type === 'tsvg:error') onerror?.(m.message);
      else if (m?.type === 'tsvg:escape')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
</script>

{#if srcdoc}
  <iframe
    bind:this={frame}
    {title}
    sandbox={TSVG_SANDBOX}
    allow={TSVG_ALLOW}
    {srcdoc}
    referrerpolicy="no-referrer"
    {...poster ? { tabindex: -1 } : {}}
    class="block border-0 bg-black {cls}"
    data-tsvg-frame={poster ? 'poster' : 'player'}
  ></iframe>
{/if}
