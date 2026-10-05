<!--
  show_ticket. Inline: the ticket at a glance and two actions (open it,
  take it). Full screen: move between stages, take it, the description and
  the thread, and a comment box. Anything that needs words beyond a comment
  goes to Claude ("Ask Claude").
-->
<script lang="ts">
  import { dueLabel, initials, renderMd } from './md';
  import { host } from './host.svelte';
  import type { View } from './types';

  let { view }: { view: Extract<View, { view: 'ticket' }> } = $props();
  const t = $derived(view.ticket);
  const due = $derived(dueLabel(t.due_at));
  const mine = $derived(t.assignees.some((a) => a.id === view.me));
  const thread = $derived((t.messages ?? []).filter((m) => !m.deleted));

  let comment = $state('');
  async function send() {
    const body = comment.trim();
    if (!body) return;
    await host.act('post_message', { key: t.key, markdown: body });
    if (!host.error) comment = '';
  }
</script>

<article class:inline={!host.fullscreen}>
  <div class="top">
    <span class="chip key">{t.key}</span>
    <span class="chip">{t.stage.name}</span>
    {#if t.priority}<span class="chip">{t.priority.name}</span>{/if}
    {#if due}<span class="chip" class:late={due.late}>due {due.text}</span>{/if}
    {#if t.state !== 'active'}<span class="chip">{t.state}</span>{/if}
  </div>
  <h2>{t.title}</h2>
  <div class="people">
    {#each t.assignees as a (a.id)}
      <span class="person"><span class="avatar">{initials(a.name || a.email)}</span>{a.name}</span>
    {:else}
      <span class="muted">Unassigned</span>
    {/each}
  </div>

  {#if !host.fullscreen}
    <div class="actions">
      {#if host.canFullscreen}
        <button class="primary" onclick={() => host.setFullscreen(true)}>Open</button>
      {:else}
        <button class="primary" onclick={() => host.open(t.url)}>Open in app ↗</button>
      {/if}
      {#if view.can.assign && !mine}
        <button
          disabled={host.busy}
          onclick={() => host.act('assign_ticket', { key: t.key, add: ['me'] })}
        >
          Take it
        </button>
      {/if}
    </div>
  {:else}
    <div class="body">
      {#if view.can.move}
        <div class="stages" role="group" aria-label="Stage">
          {#each view.board.stages as s (s.id)}
            <button
              class:on={s.id === t.stage.id}
              aria-pressed={s.id === t.stage.id}
              disabled={host.busy || s.id === t.stage.id}
              onclick={() => host.act('move_ticket', { key: t.key, stage: s.name })}
              >{s.name}</button
            >
          {/each}
        </div>
      {/if}
      <div class="actions">
        {#if view.can.assign && !mine}
          <button
            disabled={host.busy}
            onclick={() => host.act('assign_ticket', { key: t.key, add: ['me'] })}
          >
            Take it
          </button>
        {/if}
        <button class="ghost" onclick={() => host.ask(`Let's work on ${t.key} (${t.title}).`)}
          >Ask Claude</button
        >
      </div>

      <section class="md desc">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMd sanitises with DOMPurify -->
        {#if t.description_md}{@html renderMd(t.description_md)}{:else}<p class="muted">
            No description.
          </p>{/if}
      </section>

      {#if t.tags.length || Object.keys(t.fields).length}
        <dl>
          {#if t.tags.length}<dt>Tags</dt>
            <dd>{t.tags.join(', ')}</dd>{/if}
          {#each Object.entries(t.fields) as [k, val] (k)}
            <dt>{k}</dt>
            <dd>{typeof val === 'string' ? val : JSON.stringify(val)}</dd>
          {/each}
        </dl>
      {/if}

      <h3>Thread <span class="muted">{t.counts.messages}</span></h3>
      <ol class="thread">
        {#each thread as m (m.id)}
          {#if m.kind === 'system'}
            <li class="sys muted">{m.body_md}</li>
          {:else}
            <li>
              <div class="by">
                <span class="avatar">{initials(m.author.name)}</span>
                <strong>{m.author.name}</strong>
                <span class="muted">{new Date(m.created_at).toLocaleString()}</span>
              </div>
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMd sanitises with DOMPurify -->
              <div class="md">{@html renderMd(m.body_md)}</div>
            </li>
          {/if}
        {:else}
          <li class="muted">No messages yet.</li>
        {/each}
      </ol>

      {#if view.can.comment && t.state === 'active'}
        <form
          class="reply"
          onsubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea bind:value={comment} rows="3" placeholder="Write a comment (Markdown)"
          ></textarea>
          <button class="primary" disabled={!comment.trim() || host.busy}>Comment</button>
        </form>
      {/if}
    </div>
  {/if}
</article>

<style>
  article {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  article:not(.inline) {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    background: var(--bg);
  }
  .top,
  .people,
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    line-height: 1.25;
  }
  h3 {
    margin: 12px 0 0;
    font-size: 14px;
  }
  .person {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
  .stages {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .stages button.on {
    background: var(--inv-bg);
    color: var(--inv-fg);
    opacity: 1;
  }
  .desc {
    padding: 10px;
    border-radius: var(--r);
    background: var(--bg3);
  }
  dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 0;
  }
  dt {
    color: var(--fg3);
  }
  dd {
    margin: 0;
  }
  .thread {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .by {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .sys {
    font-size: 12px;
  }
  .reply {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    position: sticky;
    bottom: 0;
    padding: 8px 0;
    background: var(--bg);
  }
  .reply button {
    justify-self: end;
  }
</style>
