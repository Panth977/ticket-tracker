<!-- A code block with a Copy button: <CopyBlock label="MCP config" text={json} /> -->
<script lang="ts">
  import { Check, Copy } from 'lucide-svelte';
  import { toast } from '$lib/ui';

  interface Props {
    text: string;
    label?: string;
    /** Wrap long lines instead of scrolling. */
    wrap?: boolean;
  }
  let { text, label, wrap = false }: Props = $props();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1500);
    } catch {
      toast.error('Could not copy — select the text and copy it by hand.');
    }
  }
</script>

<div class="group relative">
  {#if label}<p class="mb-1 text-xs font-medium text-muted">{label}</p>{/if}
  <pre
    class="max-h-72 overflow-auto rounded-md border border-line bg-surface-2 py-2 pr-20 pl-3 font-mono text-xs leading-relaxed select-all {wrap
      ? 'break-all whitespace-pre-wrap'
      : ''}">{text}</pre>
  <button
    type="button"
    class="absolute right-1.5 {label
      ? 'top-6'
      : 'top-1.5'} flex items-center gap-1 rounded border border-line bg-surface px-2 py-1 text-xs text-muted hover:text-text"
    onclick={copy}
    aria-label="Copy{label ? ` ${label}` : ''}"
  >
    {#if copied}<Check size={12} /> Copied{:else}<Copy size={12} /> Copy{/if}
  </button>
</div>
