<!--
  show_my_work. Inline: how much is on my plate, what is late, the next few
  — one action, see everything. Full screen: every ticket grouped by when it
  is due; a row opens its ticket.
-->
<script lang="ts">
  import { dueLabel } from './md';
  import { host } from './host.svelte';
  import type { Brief, View } from './types';

  let { view }: { view: Extract<View, { view: 'mywork' }> } = $props();

  const now = $derived(Date.parse(view.now));
  const WEEK = 7 * 86_400_000;
  const groups = $derived.by(() => {
    const g: { name: string; tickets: Brief[] }[] = [
      { name: 'Overdue', tickets: [] },
      { name: 'This week', tickets: [] },
      { name: 'Later', tickets: [] },
      { name: 'No due date', tickets: [] },
    ];
    for (const t of view.tickets) {
      const d = t.due_at ? Date.parse(t.due_at) : null;
      g[d === null ? 3 : d < now ? 0 : d - now <= WEEK ? 1 : 2]!.tickets.push(t);
    }
    return g.filter((x) => x.tickets.length);
  });
</script>

{#snippet row(t: Brief)}
  {@const due = dueLabel(t.due_at, now)}
  <button class="row" onclick={() => host.openTicket(t.key)}>
    <span class="chip key">{t.key}</span>
    <span class="t">{t.title}</span>
    <span class="chip">{t.stage}</span>
    {#if due}<span class="chip" class:late={due.late}>{due.text}</span>{/if}
  </button>
{/snippet}

{#if !host.fullscreen}
  <section class="inline">
    <div class="sum">
      <div>
        <span class="n">{view.tickets.length}</span> <span class="muted">assigned to you</span>
      </div>
      {#if view.overdue.length}
        <span class="chip late">{view.overdue.length} overdue</span>
      {/if}
    </div>
    {#each view.tickets.slice(0, 4) as t (t.key)}{@render row(t)}{/each}
    {#if view.tickets.length > 4 && host.canFullscreen}
      <button class="primary" onclick={() => host.setFullscreen(true)}
        >See all {view.tickets.length}</button
      >
    {/if}
  </section>
{:else}
  <div class="full">
    {#each groups as g (g.name)}
      <section>
        <h3>{g.name} <span class="muted">{g.tickets.length}</span></h3>
        {#each g.tickets as t (t.key)}{@render row(t)}{/each}
      </section>
    {:else}
      <p class="muted">Nothing assigned to you. 🎉</p>
    {/each}
  </div>
{/if}

<style>
  .inline,
  section {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .sum {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .n {
    font-weight: 700;
    font-size: 20px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    border-radius: var(--r);
    background: transparent;
    padding: 6px 4px;
  }
  .row:hover {
    background: var(--bg2);
  }
  .t {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .full {
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: 16px;
    padding: 12px;
    background: var(--bg);
  }
  h3 {
    margin: 0 0 4px;
    font-size: 14px;
  }
</style>
