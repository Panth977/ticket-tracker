<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import type { IconComponent } from '$lib/ui/types';

  interface Props {
    href?: string;
    onclick?: () => void;
    icon?: IconComponent;
    active?: boolean;
    indent?: number;
    count?: number | null;
    /** Right-aligned extra (kbd, dot). */
    trailing?: Snippet;
    children: Snippet;
  }
  let {
    href,
    onclick,
    icon: Icon,
    active = false,
    indent = 0,
    count,
    trailing,
    children,
  }: Props = $props();
  const cls = $derived(
    `group flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-sm transition-colors
     ${active ? 'bg-surface-3 font-medium text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}`,
  );
  const pad = $derived(`padding-left: ${0.5 + indent * 1.25}rem`);
</script>

{#snippet body()}
  {#if Icon}<Icon size={15} class="shrink-0" aria-hidden="true" />{/if}
  <span class="flex-1 truncate">{@render children()}</span>
  {#if count}<span class="text-xs tabular-nums {active ? 'text-text' : 'text-subtle'}"
      >{count > 99 ? '99+' : count}</span
    >{/if}
  {@render trailing?.()}
{/snippet}

{#if href}
  <a {href} class={cls} style={pad} aria-current={active ? 'page' : undefined}>{@render body()}</a>
{:else}
  <button type="button" class={cls} style={pad} {onclick}>{@render body()}</button>
{/if}
