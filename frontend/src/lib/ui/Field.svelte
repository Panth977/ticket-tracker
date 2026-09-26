<!-- Label + control + hint/error wrapper used by Input, Textarea, Select, DatePicker. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  interface Props {
    id: string;
    label?: string;
    hint?: string;
    error?: string | null;
    required?: boolean;
    class?: string;
    children: Snippet;
  }
  let { id, label, hint, error, required = false, class: cls = '', children }: Props = $props();
</script>

<div class="flex flex-col gap-1 {cls}">
  {#if label}
    <label for={id} class="text-xs font-medium text-muted">
      {label}{#if required}<span class="text-danger" aria-hidden="true"> *</span>{/if}
    </label>
  {/if}
  {@render children()}
  {#if error}
    <p id="{id}-msg" class="text-xs text-danger" role="alert">{error}</p>
  {:else if hint}
    <p id="{id}-msg" class="text-xs text-subtle">{hint}</p>
  {/if}
</div>
