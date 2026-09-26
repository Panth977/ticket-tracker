<!--
  Stand-in for a screen whose owner has not built it yet (web-core t7).
  Page owners REPLACE the +page.svelte that renders this; never extend it.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { Construction } from 'lucide-svelte';

  interface Props {
    /** Screen name from docs/data/app/app.json. */
    screen: string;
    /** Owning build step. */
    owner: string;
    route: string;
  }
  let { screen, owner, route }: Props = $props();
  const params = $derived(Object.entries(page.params));
</script>

<section class="mx-auto flex max-w-2xl flex-col gap-3 px-6 py-12" data-placeholder={screen}>
  <div class="flex items-center gap-2 text-muted">
    <Construction size={18} aria-hidden="true" />
    <span class="text-xs font-medium tracking-wide uppercase">Placeholder · {owner}</span>
  </div>
  <h1 class="text-2xl font-semibold">{screen}</h1>
  <p class="font-mono text-sm text-muted">{route}</p>
  {#if params.length}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {#each params as [k, v] (k)}
        <dt class="text-muted">{k}</dt>
        <dd class="font-mono">{v}</dd>
      {/each}
    </dl>
  {/if}
</section>
