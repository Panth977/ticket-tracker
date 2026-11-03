<!--
  One of the board script's previews (docs/plan/board-script.html §previews):
  `previews({ me, board })[name]` drawn as a tab of the board. It runs in its own
  worker (stateful, like a form), gets the board's shown tickets (after the
  script's filters) and redraws when they change. openTicket({ id }) opens the
  drawer; updateTicket({ id, patch }) writes a checked patch as the viewer.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { TriangleAlert } from 'lucide-svelte';
  import { ScriptPatchSchema, type Board, type Ticket, type TicketPatch } from '@tm/shared';
  import { toast } from '$lib/ui';
  import { createRenderer, type Renderer } from './render';
  import { TemplateWorker, type TemplateProblem } from './host';
  import { contextFor, createBridge } from './bridge';
  import { mountPerson } from './mountPerson';
  import { widgetMounter } from './widgets/mountWidget.svelte';
  import type { BoardScriptHost, ScriptMe } from './script';

  type Raw = Ticket & { id: string };
  interface Props {
    name: string;
    code: string;
    host: BoardScriptHost;
    board: Board & { id: string };
    me: ScriptMe;
    tz: string;
    tickets: Raw[];
    openTicket: (key: string) => void;
    ticketHref?: (key: string) => string;
    write: (ticket: Raw, patch: TicketPatch) => void;
  }
  let { name, code, host, board, me, tz, tickets, openTicket, ticketHref, write }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let problem = $state<TemplateProblem | null>(null);
  let worker: TemplateWorker | null = null;
  let renderer: Renderer | null = null;
  const byId = $derived(new Map(tickets.map((t) => [t.id, t])));

  function stop() {
    worker?.destroy();
    worker = null;
    renderer?.destroy();
    renderer = null;
  }

  $effect(() => {
    const el = root;
    const n = name;
    const c = code;
    if (!el) return;
    const { b, who, list } = untrack(() => ({
      b: $state.snapshot(board) as typeof board,
      who: $state.snapshot(me) as ScriptMe,
      list: $state.snapshot(tickets) as Raw[],
    }));
    let cancelled = false;
    stop();
    problem = null;
    const r = createRenderer(el, {
      dispatch: (h, args) => worker?.event(h, args) ?? 0,
      person: mountPerson,
      widget: widgetMounter(tz),
      ticketHref,
      openTicket,
    });
    renderer = r;
    const bridge = createBridge({ board: b, me: who, templateId: 'script' });
    void Promise.all([
      contextFor(bridge, { kind: 'preview', tz }),
      Promise.all(list.map((t) => host.ticketOf(t))),
    ]).then(([ctx, st]) => {
      if (cancelled) return;
      worker = new TemplateWorker({
        code: c,
        kind: 'preview',
        entry: { surface: 'preview', id: n },
        tickets: st,
        ctx,
        bridge,
        onRender: (tree, ack) => r.update(tree, ack),
        onError: (p) => (problem = p),
        onOpen: (id) => {
          const t = untrack(() => byId.get(id));
          if (t) openTicket(t.key);
        },
        onUpdate: (id, patch) => {
          const t = untrack(() => byId.get(id));
          const p = ScriptPatchSchema.safeParse(patch);
          if (!t) return void toast.error('updateTicket: no such ticket on this board');
          if (!p.success) return void toast.error(`updateTicket: ${p.error.issues[0]?.message}`);
          write(t, p.data as TicketPatch);
        },
      });
    });
    return () => {
      cancelled = true;
      stop();
    };
  });
  onDestroy(stop);

  // The board's tickets changed (a write, a filter): the preview redraws with them.
  let seq = 0;
  $effect(() => {
    const list = tickets;
    const h = host;
    const n = ++seq;
    void Promise.all(list.map((t) => h.ticketOf(t))).then((st) => {
      if (n === seq) worker?.setTickets(st);
    });
  });
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-4" data-preview={name}>
  {#if problem}
    <div
      role="alert"
      class="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger"
    >
      <TriangleAlert size={14} class="mt-0.5 shrink-0" />
      <span class="min-w-0 break-words"
        ><b class="font-semibold"
          >Board script · {name}{problem.line ? ` · line ${problem.line}` : ''}:</b
        >
        {problem.message}</span
      >
    </div>
  {/if}
  <div bind:this={root} class="tm-template flex flex-col gap-3 text-sm"></div>
</div>
