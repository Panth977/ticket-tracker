<!--
  One entity in an access row or in the Add dialog: its mark (an agent's
  avatar), a board's key, its name — or "A board you are not on" when the
  viewer cannot open it — and, when asked, its kind.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- hrefs from lib/layout/routes; no base path */
  import { PrincipalAvatar } from '$lib/people';
  import Indicator from '$lib/ui/Indicator.svelte';
  import type { EntityView } from './entities';
  import { HIDDEN_LABEL, KIND_LABEL } from './relations';

  interface Props {
    entity: EntityView;
    /** Show the kind ("Board", "Memory"…) as a small label. */
    showKind?: boolean;
    /** Make the name a link (rows) — the dialog's list is buttons instead. */
    link?: boolean;
    class?: string;
  }
  let { entity: e, showKind = false, link = false, class: cls = '' }: Props = $props();
</script>

{#snippet body()}
  {#if e.kind === 'agent'}
    <PrincipalAvatar id={e.id} size={20} />
  {:else if e.mark}
    <Indicator
      of={e.mark.of}
      indicator={e.mark.indicator}
      seed={e.mark.seed}
      fallback={e.mark.fallback}
      size="sm"
    />
  {/if}
  {#if e.name !== null}
    {#if e.key}<span class="font-mono text-xs text-muted">{e.key}</span>{/if}
    <span class="truncate font-medium" data-entity-name>{e.name}</span>
  {:else}
    <span class="truncate text-muted italic" data-entity-name>{HIDDEN_LABEL[e.kind]}</span>
  {/if}
{/snippet}

<span class="flex min-w-0 items-center gap-1.5 {cls}">
  {#if link && e.href && e.name !== null}
    <a href={e.href} class="flex min-w-0 items-center gap-1.5 hover:underline">{@render body()}</a>
  {:else}
    {@render body()}
  {/if}
  {#if showKind}
    <span
      class="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted"
      data-entity-kind>{KIND_LABEL[e.kind]}</span
    >
  {/if}
  {#if e.note}<span class="shrink-0 text-xs text-muted">· {e.note}</span>{/if}
</span>
