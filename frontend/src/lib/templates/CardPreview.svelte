<!--
  The editor's preview of a CARD template (templates.html §E): one of the
  board's tickets, drawn the way the board will draw it — a static tree from
  the same sandboxed worker, inside a card frame.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Board, Ticket } from '@tm/shared';
  import { contextFor, createBridge } from './bridge';
  import { TemplateWorker, type TemplateLog, type TemplateProblem } from './host';
  import { createRenderer } from './render';
  import { mountPerson } from './mountPerson';

  interface Props {
    code: string;
    templateId: string;
    board: Board & { id: string };
    me: { id: string; name: string; email: string; role: string };
    ticket: (Ticket & { id: string }) | null;
    onlog?: (l: TemplateLog) => void;
    onproblem?: (p: TemplateProblem | null) => void;
  }
  let { code, templateId, board, me, ticket, onlog, onproblem }: Props = $props();

  let root: HTMLDivElement | undefined = $state();

  $effect(() => {
    const src = code;
    const t = ticket ? ($state.snapshot(ticket) as Ticket & { id: string }) : null;
    const el = root;
    if (!el || !t) return;
    const { b, who } = untrack(() => ({
      b: $state.snapshot(board) as typeof board,
      who: $state.snapshot(me) as typeof me,
    }));
    untrack(() => onproblem?.(null));
    const r = createRenderer(el, { person: mountPerson });
    const bridge = createBridge({ board: b, me: who, templateId });
    let w: TemplateWorker | null = null;
    let live = true;
    void contextFor(bridge, { kind: 'card' }).then(async (ctx) => {
      if (!live) return;
      w = new TemplateWorker({
        code: src,
        kind: 'card',
        ctx,
        bridge,
        onError: (p) => onproblem?.(p),
        onLog: (l) => onlog?.(l),
      });
      try {
        await w.ready;
      } catch {
        return;
      }
      const [res] = await w.cards([{ id: t.id, ctx: { ticket: await bridge.infoOf(t) } }]);
      if (!live || !res) return;
      if (res.tree) r.update(res.tree, 0);
      else onproblem?.({ phase: 'render', message: res.error ?? 'failed', line: res.line });
    });
    return () => {
      live = false;
      w?.destroy();
      r.destroy();
    };
  });
</script>

{#if ticket}
  <div class="w-72 rounded-md border border-line bg-surface p-2 text-left shadow-sm">
    <div bind:this={root} class="tm-template-card text-sm"></div>
  </div>
{:else}
  <p class="text-sm text-muted">This board has no active tickets to preview a card with.</p>
{/if}
