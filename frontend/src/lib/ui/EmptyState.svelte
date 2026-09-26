<!--
  <EmptyState icon={Inbox} title="You're all caught up" description="…">
    {#snippet action()}<Button>New ticket</Button>{/snippet}
  </EmptyState>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconComponent } from './types';

  interface Props {
    icon?: IconComponent;
    title: string;
    description?: string;
    action?: Snippet;
    class?: string;
  }
  let { icon: Icon, title, description, action, class: cls = '' }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center {cls}">
  {#if Icon}
    <span class="mb-1 grid size-10 place-items-center rounded-full bg-surface-2 text-muted"
      ><Icon size={20} aria-hidden="true" /></span
    >
  {/if}
  <h3 class="text-sm font-semibold">{title}</h3>
  {#if description}<p class="max-w-sm text-sm text-muted">{description}</p>{/if}
  {#if action}<div class="mt-2">{@render action()}</div>{/if}
</div>
