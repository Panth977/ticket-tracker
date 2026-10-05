<!--
  The shell: which screen, Back, full screen, "open in TaskManager", errors.
  Inline (in the conversation) every screen is a compact card; full screen
  is the working surface.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Board from './Board.svelte';
  import MyWork from './MyWork.svelte';
  import Ticket from './Ticket.svelte';
  import { host } from './host.svelte';

  onMount(() => {
    host.start().catch((e: unknown) => (host.error = String(e)));
  });

  const v = $derived(host.view);
  const url = $derived(
    v?.view === 'board' ? v.board.url : v?.view === 'ticket' ? v.ticket.url : null,
  );
  const pad = $derived(
    `padding: ${host.insets.top}px ${host.insets.right}px ${host.insets.bottom}px ${host.insets.left}px`,
  );
</script>

<main class:full={host.fullscreen} style={host.fullscreen ? pad : ''} aria-busy={host.busy}>
  {#if host.fullscreen || host.stack.length}
    <header>
      {#if host.stack.length}
        <button class="ghost" onclick={() => host.back()} aria-label="Back">←</button>
      {/if}
      <strong class="title">
        {#if v?.view === 'board'}{v.board.name}{:else if v?.view === 'ticket'}{v.ticket
            .key}{:else if v?.view === 'mywork'}My work{/if}
      </strong>
      {#if host.busy}<span class="muted">Saving…</span>{/if}
      <span class="spacer"></span>
      {#if url}<button class="ghost" onclick={() => host.open(url)}>Open in app ↗</button>{/if}
      {#if host.canFullscreen}
        <button class="ghost" onclick={() => host.setFullscreen(!host.fullscreen)}>
          {host.fullscreen ? 'Close' : 'Expand'}
        </button>
      {/if}
    </header>
  {/if}

  {#if host.error}
    <p class="error" role="alert">
      {host.error}
      <button class="ghost" onclick={() => (host.error = null)} aria-label="Dismiss">✕</button>
    </p>
  {/if}

  {#if !v}
    <div class="loading" aria-label="Loading">
      <div class="skeleton" style="height: 18px; width: 40%"></div>
      <div class="skeleton" style="height: 48px"></div>
      <div class="skeleton" style="height: 48px"></div>
    </div>
  {:else if v.view === 'board'}
    <Board view={v} />
  {:else if v.view === 'ticket'}
    <Ticket view={v} />
  {:else}
    <MyWork view={v} />
  {/if}
</main>

<style>
  main {
    padding: 12px;
  }
  main.full {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 0;
    background: var(--bg3);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 0.5px solid var(--line);
    background: var(--bg);
  }
  .title {
    font-size: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1;
  }
  .error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 8px 12px;
    padding: 6px 10px;
    border-radius: var(--r);
    background: var(--danger-bg);
    color: var(--danger);
  }
  .loading {
    display: grid;
    gap: 8px;
  }
</style>
