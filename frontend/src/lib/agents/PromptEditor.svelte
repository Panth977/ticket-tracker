<!--
  The system prompt editor (agents.html §B): Markdown in a monospace textarea,
  with Write / Preview / Split. The preview renders the same way messages do
  (Markdown → rich text → RichView). Tab indents; ⌘S / Ctrl+S calls `onsave`.
-->
<script lang="ts">
  import { markdownToDoc } from '@tm/shared';
  import RichView from '$lib/editor/RichView.svelte';
  import { Tabs } from '$lib/ui';
  import { AGENT_SYSTEM_PROMPT_MAX } from './agents';

  interface Props {
    value: string;
    error?: string | null;
    onsave?: () => void;
  }
  let { value = $bindable(''), error, onsave }: Props = $props();

  let mode = $state<'write' | 'preview' | 'split'>('split');
  const doc = $derived.by(() => {
    if (mode === 'write') return null;
    try {
      return markdownToDoc(value);
    } catch {
      return null;
    }
  });
  const over = $derived(value.length > AGENT_SYSTEM_PROMPT_MAX);
  const lines = $derived(value ? value.split('\n').length : 0);

  function keydown(e: KeyboardEvent) {
    const ta = e.currentTarget as HTMLTextAreaElement;
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      onsave?.();
      return;
    }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = ta;
      value = value.slice(0, s) + '  ' + value.slice(end);
      queueMicrotask(() => ta.setSelectionRange(s + 2, s + 2));
    }
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <Tabs
      label="Prompt view"
      items={[
        { id: 'write', label: 'Write' },
        { id: 'preview', label: 'Preview' },
        { id: 'split', label: 'Split' },
      ]}
      bind:value={mode}
    />
    <span class="text-xs {over ? 'text-danger' : 'text-subtle'}" aria-live="polite">
      {lines} line{lines === 1 ? '' : 's'} · {value.length.toLocaleString('en-US')} / {AGENT_SYSTEM_PROMPT_MAX.toLocaleString(
        'en-US',
      )}
    </span>
  </div>
  <div class="grid grid-cols-1 gap-3 {mode === 'split' ? 'lg:grid-cols-2' : ''}">
    {#if mode !== 'preview'}
      <label class="flex min-w-0 flex-col">
        <span class="sr-only">System prompt (Markdown)</span>
        <textarea
          bind:value
          onkeydown={keydown}
          spellcheck="false"
          rows="22"
          placeholder="# Role&#10;You are …"
          aria-invalid={error || over ? true : undefined}
          class="min-h-[22rem] w-full resize-y rounded-md border bg-bg px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-accent {error ||
          over
            ? 'border-danger'
            : 'border-line'}"
          data-prompt-input></textarea>
      </label>
    {/if}
    {#if mode !== 'write'}
      <div
        class="max-h-[40rem] min-h-[22rem] min-w-0 overflow-y-auto rounded-md border border-line bg-surface px-4 py-3"
        data-prompt-preview
      >
        {#if value.trim() && doc}
          <RichView {doc} />
        {:else}
          <p class="text-sm text-subtle">Nothing to preview yet.</p>
        {/if}
      </div>
    {/if}
  </div>
  {#if error}<p class="text-xs text-danger">{error}</p>{/if}
  <p class="text-xs text-muted">
    Markdown. The agent’s token gets it from <code>GET /v1/me</code> and the MCP tool
    <code>whoami</code>, so an orchestrator can load the prompt from the token alone.
  </p>
</div>
