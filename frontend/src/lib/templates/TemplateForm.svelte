<!--
  A message or ticket template's FORM (docs/plan/templates.html §B): the
  board's code runs in a sandboxed worker; this draws the tree it renders and
  sends it what you type. The dialog around it calls submit().
    <TemplateForm bind:this={form} {template} {board} {me} ticket={info} />
    const r = await form.submit();   // { result } | { error, line }
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { Board, TemplateKind } from '@tm/shared';
  import { TriangleAlert } from 'lucide-svelte';
  import { createRenderer, type Renderer } from './render';
  import { TemplateWorker, type TemplateLog, type TemplateProblem } from './host';
  import { contextFor, createBridge } from './bridge';
  import { mountPerson } from './mountPerson';
  import type { TicketInfo } from './info';

  interface Props {
    template: { id: string; kind: TemplateKind; code: string };
    board: Board & { id: string };
    me: { id: string; name: string; email: string; role: string };
    /** A message template's ticket (ctx.ticket). */
    ticket?: TicketInfo | null;
    ticketHref?: (key: string) => string;
    openTicket?: (key: string) => void;
    onlog?: (l: TemplateLog) => void;
    /** Every problem (compile, render, timeout); null when a fresh start is clean. */
    onproblem?: (p: TemplateProblem | null) => void;
    /** true once the first tree is drawn. */
    ready?: boolean;
    /** Draw problems here (the editor draws its own, with jump-to-line). */
    showProblem?: boolean;
    class?: string;
  }
  let {
    template,
    board,
    me,
    ticket = null,
    ticketHref,
    openTicket,
    onlog,
    onproblem,
    // eslint-disable-next-line no-useless-assignment -- $bindable()'s argument is the fallback when the parent does not bind, not a first value
    ready = $bindable(false),
    showProblem = true,
    class: cls = '',
  }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let problem = $state<TemplateProblem | null>(null);
  let worker: TemplateWorker | null = null;
  let renderer: Renderer | null = null;

  function stop() {
    worker?.destroy();
    worker = null;
    renderer?.destroy();
    renderer = null;
  }

  $effect(() => {
    // Restart whenever the code (or the template) changes.
    const code = template.code;
    const kind = template.kind;
    const id = template.id;
    const el = root;
    if (!el) return;
    // Live board / ticket updates must not restart the form (it would lose what was typed).
    const { b, who, tk, href, open } = untrack(() => ({
      b: $state.snapshot(board) as typeof board,
      who: $state.snapshot(me) as typeof me,
      tk: ticket ? ($state.snapshot(ticket) as TicketInfo) : null,
      href: ticketHref,
      open: openTicket,
    }));
    let cancelled = false;
    stop();
    untrack(() => {
      ready = false;
      problem = null;
      onproblem?.(null);
    });
    const r = createRenderer(el, {
      dispatch: (h, args) => worker?.event(h, args) ?? 0,
      person: mountPerson,
      ticketHref: href,
      openTicket: open,
    });
    renderer = r;
    const bridge = createBridge({ board: b, me: who, templateId: id });
    void contextFor(bridge, { kind, ticket: tk }).then((ctx) => {
      if (cancelled) return;
      worker = new TemplateWorker({
        code,
        kind,
        ctx,
        bridge,
        onRender: (tree, ack) => {
          r.update(tree, ack);
          if (tree) ready = true;
        },
        onError: (p) => {
          problem = p;
          onproblem?.(p);
        },
        onLog: (l) => onlog?.(l),
      });
    });
    return () => {
      cancelled = true;
      stop();
    };
  });
  onDestroy(stop);

  /** Run the template's submit(state, ctx). */
  export async function submit(): Promise<{ result?: unknown; error?: string; line?: number }> {
    if (!worker) return { error: 'The template is still starting' };
    return worker.submit();
  }
  /** Show a refused submit's field errors under the inputs they name. */
  export function setErrors(errors: Record<string, string>) {
    renderer?.setErrors(errors);
  }
</script>

<div class="flex flex-col gap-2 {cls}">
  {#if problem && showProblem}
    <div
      role="alert"
      class="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger"
    >
      <TriangleAlert size={14} class="mt-0.5 shrink-0" />
      <span class="min-w-0 break-words">
        <b class="font-semibold"
          >{problem.phase === 'timeout'
            ? 'Stopped'
            : `Template ${problem.phase} error`}{problem.line ? ` · line ${problem.line}` : ''}:</b
        >
        {problem.message}
      </span>
    </div>
  {/if}
  <div
    bind:this={root}
    class="tm-template flex flex-col gap-3 text-sm"
    data-template={template.id}
  ></div>
</div>
