<!-- A titled block inside an account section. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  interface Props {
    title?: string;
    description?: string;
    tone?: 'default' | 'danger';
    children: Snippet;
    actions?: Snippet;
  }
  let { title, description, tone = 'default', children, actions }: Props = $props();
</script>

<section
  class="flex flex-col gap-4 rounded-xl border bg-surface p-5 {tone === 'danger'
    ? 'border-danger/40'
    : 'border-line'}"
>
  {#if title || actions}
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        {#if title}<h3 class="font-medium {tone === 'danger' ? 'text-danger' : ''}">
            {title}
          </h3>{/if}
        {#if description}<p class="mt-0.5 text-sm text-muted">{description}</p>{/if}
      </div>
      {#if actions}<div class="flex gap-2">{@render actions()}</div>{/if}
    </div>
  {/if}
  {@render children()}
</section>
