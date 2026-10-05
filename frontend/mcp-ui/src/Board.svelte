<!--
  show_board. Inline: the stages with their counts and the board's due-soon
  work — one action, open the board. Full screen: the kanban — columns by
  stage, a card opens its ticket, "+ Add" creates one in that column.
-->
<script lang="ts">
  import { dueLabel, initials } from './md';
  import { host } from './host.svelte';
  import type { Brief, View } from './types';

  let { view }: { view: Extract<View, { view: 'board' }> } = $props();

  const columns = $derived(
    view.board.stages.map((s) => ({
      ...s,
      tickets: view.tickets.filter((t) => t.stage === s.name),
    })),
  );
  const soon = $derived(
    view.tickets
      .filter((t) => t.due_at)
      .sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!))
      .slice(0, 3),
  );

  let adding = $state<string | null>(null);
  let title = $state('');
  async function add(stage: string) {
    const t = title.trim();
    if (!t) return;
    await host.act('create_ticket', { board: view.board.key, title: t, stage });
    title = '';
    adding = null;
  }
</script>

{#snippet card(t: Brief)}
  {@const due = dueLabel(t.due_at)}
  <button class="card" onclick={() => host.openTicket(t.key)}>
    <span class="chip key">{t.key}</span>
    <span class="t">{t.title}</span>
    <span class="meta">
      {#if t.priority}<span class="chip">{t.priority}</span>{/if}
      {#if due}<span class="chip" class:late={due.late}>{due.text}</span>{/if}
      <span class="spacer"></span>
      {#each t.assignees.slice(0, 3) as a (a)}<span class="avatar" title={a}>{initials(a)}</span
        >{/each}
    </span>
  </button>
{/snippet}

{#if !host.fullscreen}
  <section class="inline">
    <div class="head">
      <strong>{view.board.name}</strong>
      <span class="chip key">{view.board.key}</span>
    </div>
    <div class="stages">
      {#each columns as c (c.id)}
        <div class="stage">
          <span class="n">{c.tickets.length}</span>
          <span class="muted">{c.name}</span>
        </div>
      {/each}
    </div>
    {#if soon.length}
      <div class="soon">
        {#each soon as t (t.key)}
          {@const due = dueLabel(t.due_at)}
          <button class="row" onclick={() => host.openTicket(t.key)}>
            <span class="chip key">{t.key}</span>
            <span class="t">{t.title}</span>
            {#if due}<span class="chip" class:late={due.late}>{due.text}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
    {#if host.canFullscreen}
      <button class="primary" onclick={() => host.setFullscreen(true)}>Open board</button>
    {/if}
  </section>
{:else}
  <div class="kanban">
    {#each columns as c (c.id)}
      <section class="col" aria-label={c.name}>
        <h3>{c.name} <span class="muted">{c.tickets.length}</span></h3>
        <div class="cards">
          {#each c.tickets as t (t.key)}{@render card(t)}{/each}
        </div>
        {#if view.can.create}
          {#if adding === c.id}
            <form
              class="add"
              onsubmit={(e) => {
                e.preventDefault();
                void add(c.name);
              }}
            >
              <!-- svelte-ignore a11y_autofocus -->
              <input bind:value={title} placeholder="Ticket title" autofocus />
              <div class="row-btns">
                <button class="primary" disabled={!title.trim() || host.busy}>Add</button>
                <button type="button" class="ghost" onclick={() => (adding = null)}>Cancel</button>
              </div>
            </form>
          {:else}
            <button class="ghost addbtn" onclick={() => ((adding = c.id), (title = ''))}
              >+ Add</button
            >
          {/if}
        {/if}
      </section>
    {/each}
  </div>
  {#if view.truncated}<p class="muted note">Showing the first 400 tickets.</p>{/if}
{/if}

<style>
  .inline {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 16px;
  }
  .stages {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .stage {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 10px;
    border-radius: var(--r);
    background: var(--bg2);
  }
  .n {
    font-weight: 700;
    font-size: 16px;
  }
  .soon {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    border: 0;
    background: transparent;
    padding: 4px 0;
  }
  .t {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kanban {
    flex: 1;
    display: flex;
    gap: 12px;
    padding: 12px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scroll-padding-inline: 12px;
  }
  .col {
    flex: 0 0 min(300px, 85vw);
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    scroll-snap-align: start;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    min-height: 0;
  }
  .card {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    padding: 10px;
    text-align: left;
    background: var(--bg);
    border: 0.5px solid var(--line);
    border-radius: var(--r-lg);
  }
  .card .t {
    white-space: normal;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .spacer {
    flex: 1;
  }
  .add {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
  .row-btns {
    display: flex;
    gap: 6px;
  }
  .addbtn {
    justify-self: start;
    color: var(--fg3);
  }
  .note {
    padding: 0 12px 12px;
  }
</style>
