<!--
  One kanban card drawn by a card template (docs/plan/templates.html §E). The
  tree comes from the template's shared worker (./cards); until it arrives, or
  when the template fails on this ticket, the built-in card (`fallback`) is
  drawn instead, with a ⚠ saying why.
-->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { TriangleAlert } from 'lucide-svelte';
  import type { Board, TemplateWithId, Ticket } from '@tm/shared';
  import { acquireCardHost, releaseCardHost, type CardHost } from './cards';
  import { createRenderer, type Renderer } from './render';
  import { mountPerson } from './mountPerson';

  interface Props {
    template: TemplateWithId;
    board: Board & { id: string };
    ticket: Ticket & { id: string };
    me: { id: string; name: string; email: string; role: string };
    ticketHref?: (key: string) => string;
    fallback: Snippet;
  }
  let { template, board, ticket, me, ticketHref, fallback }: Props = $props();

  // One host per template version; the card re-acquires when the template is saved again.
  let host = $state<CardHost | null>(null);
  $effect(() => {
    const boardId = board.id;
    void template.id;
    void template.updatedAt;
    const h = untrack(() =>
      acquireCardHost(
        $state.snapshot(template) as TemplateWithId,
        $state.snapshot(board) as typeof board,
        $state.snapshot(me) as typeof me,
      ),
    );
    host = h;
    return () => releaseCardHost(h, boardId);
  });

  let root: HTMLDivElement | undefined = $state();
  let renderer = $state<Renderer | null>(null);
  $effect(() => {
    if (!root) return;
    const r = createRenderer(root, { person: mountPerson, ticketHref });
    renderer = r;
    return () => r.destroy();
  });

  let shown = $state<'loading' | 'ok' | 'error'>('loading');
  let error = $state('');
  $effect(() => {
    const r = renderer;
    const h = host;
    const t = ticket;
    void t.updatedAt;
    if (!r || !h) return;
    let live = true;
    void h.tree(t).then((res) => {
      if (!live) return;
      if (res.tree) {
        r.update(res.tree, 0);
        shown = 'ok';
      } else {
        shown = 'error';
        error = `${template.name}: ${res.error ?? 'failed'}${res.line ? ` (line ${res.line})` : ''}`;
      }
    });
    return () => {
      live = false;
    };
  });
</script>

<div class="tm-template-card text-sm" class:hidden={shown !== 'ok'} bind:this={root}></div>
{#if shown !== 'ok'}
  <div class="relative">
    {#if shown === 'error'}
      <span class="absolute -top-1 right-0 text-warning" title={error} aria-label={error}
        ><TriangleAlert size={12} /></span
      >
    {/if}
    {@render fallback()}
  </div>
{/if}
