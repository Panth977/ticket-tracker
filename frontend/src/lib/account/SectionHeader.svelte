<script lang="ts">
  import type { Snippet } from 'svelte';
  interface Props {
    title: string;
    description?: string;
    actions?: Snippet;
  }
  let { title, description, actions }: Props = $props();
</script>

<header class="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
  <div>
    <h2 class="text-xl font-semibold">{title}</h2>
    {#if description}<p class="mt-1 max-w-prose text-sm text-muted">{description}</p>{/if}
  </div>
  {#if actions}<div class="flex gap-2">{@render actions()}</div>{/if}
</header>
