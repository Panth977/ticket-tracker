<!--
  Code mode's editor: CodeMirror, loaded on first use (./codemirror). Follows
  the app's light / dark theme live. `value` is what was loaded; edits are
  reported through onchange, ⌘S through onsave.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { createCodeEditor, isDarkTheme, type CodeEditor } from './codemirror';

  interface Props {
    value: string;
    name: string;
    readOnly?: boolean;
    onchange?: (text: string) => void;
    onsave?: () => void;
  }
  let { value, name, readOnly = false, onchange, onsave }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let editor: CodeEditor | null = null;
  let ready = $state(false);
  let failed = $state(false);

  // (Re)create when the file (name) changes — a different language, a fresh history.
  $effect(() => {
    const el = host;
    const n = name;
    const text = value;
    if (!el) return;
    let alive = true;
    ready = false;
    editor?.destroy();
    editor = null;
    createCodeEditor({
      parent: el,
      text,
      name: n,
      readOnly: untrack(() => readOnly),
      dark: isDarkTheme(),
      onChange: (t) => onchange?.(t),
      onSave: () => onsave?.(),
    })
      .then((ed) => {
        if (!alive) return ed.destroy();
        editor = ed;
        ready = true;
      })
      .catch(() => {
        if (alive) failed = true;
      });
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    editor?.setReadOnly(readOnly);
  });

  // The theme can change while the editor is open (account menu, or the OS).
  $effect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => editor?.setDark(isDarkTheme());
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', sync);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', sync);
    };
  });

  onDestroy(() => editor?.destroy());

  /** The editor's current text (the parent reads it to save). */
  export function text(): string | null {
    return editor?.getText() ?? null;
  }
  export function focus() {
    editor?.focus();
  }
</script>

<div class="relative h-full min-h-0" data-code-editor>
  {#if failed}
    <p class="p-4 text-sm text-danger">The editor could not be loaded. Try reloading the page.</p>
  {:else if !ready}
    <div class="absolute inset-0 flex flex-col gap-2 p-4"><Skeleton lines={8} /></div>
  {/if}
  <div bind:this={host} class="h-full min-h-0 overflow-hidden {ready ? '' : 'invisible'}"></div>
</div>
