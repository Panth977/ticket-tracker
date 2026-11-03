<!--
  Board settings › Script (docs/plan/board-script.html): the board's own code
  for its ticket fields, its filters and its sort. Left: the code. Right: a
  LIVE preview that runs the draft in the same sandboxed worker the board uses
  — the Filter controls (and how many tickets they keep), and a ticket's
  fields under Stage; changing a field shows the patch onFieldChange would
  write, without writing it. Admins save; everyone else may read the code.
-->
<script lang="ts">
  // /integrate is a static page beside the SPA, not a route of it.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { onDestroy, untrack } from 'svelte';
  import { AlignLeft, BookOpen, CircleAlert, RotateCcw, TriangleAlert } from 'lucide-svelte';
  import {
    DEFAULT_BOARD_SCRIPT,
    generateBoardScript,
    SCRIPT_TEMPLATE_ID,
    type ScriptControl,
    type ScriptFilters,
    type Ticket,
  } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Button, toast } from '$lib/ui';
  import ScriptEditor, { type ScriptProblem } from '$lib/templates/editor/ScriptEditor.svelte';
  import ScriptControls from '$lib/templates/ScriptControls.svelte';
  import { boardSources } from '$lib/templates/bridge';
  import type { TemplateLog } from '$lib/templates/host';
  import {
    BoardScriptHost,
    effectiveBoardScript,
    savedScript,
    type ScriptMe,
  } from '$lib/templates/script';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const saved = savedScript(s.board.id);
  const effective = $derived($saved.loading ? null : effectiveBoardScript(s.board, $saved.data));

  // ── the draft ──
  let code = $state('');
  let previewCode = $state('');
  let loadedFrom = $state<string | null>(null);
  let busy = $state(false);
  let editor: ScriptEditor | undefined = $state();
  /** What the editor's type-check says (errors first). */
  let problems = $state<ScriptProblem[]>([]);
  const errors = $derived(problems.filter((p) => p.severity === 'error').length);
  $effect(() => {
    const e = effective;
    if (!e) return;
    untrack(() => {
      // Follow the saved code until I have edits of my own.
      if (loadedFrom === null || code === loadedFrom) {
        code = e.code;
        previewCode = e.code;
      }
      loadedFrom = e.code;
    });
  });
  const dirty = $derived(
    effective != null && (code !== effective.code || effective.source !== 'saved'),
  );
  let debounce: ReturnType<typeof setTimeout> | undefined;
  function onCode(c: string) {
    code = c;
    clearTimeout(debounce);
    debounce = setTimeout(() => (previewCode = c), 600);
  }

  // ── the preview: a host on the draft code ──
  const me = $derived<ScriptMe>({
    id: s.me,
    name: auth.profile?.name || s.members.find((m) => m.uid === s.me)?.name || '',
    email: auth.user?.email ?? s.members.find((m) => m.uid === s.me)?.email ?? '',
    role: s.role ?? '',
  });
  let logs = $state<TemplateLog[]>([]);
  let problem = $state<string | null>(null);
  let host = $state<BoardScriptHost | null>(null);
  $effect(() => {
    const c = previewCode;
    if (!c) return;
    const h = new BoardScriptHost(
      c,
      s.board,
      untrack(() => me),
      {
        onLog: (l) => (logs = [...logs.slice(-49), l]),
        onError: (p) =>
          (problem = `${p.phase} error${p.line ? ` (line ${p.line})` : ''}: ${p.message}`),
      },
    );
    problem = null;
    host = h;
    return () => h.destroy();
  });
  onDestroy(() => clearTimeout(debounce));

  const src = boardSources(s.board.id, s.me);
  const ticketsStore = src.tickets;
  const tickets = $derived($ticketsStore.data);
  let sampleId = $state<string | null>(null);
  const sample = $derived<(Ticket & { id: string }) | null>(
    tickets.find((t) => t.id === sampleId) ?? tickets[0] ?? null,
  );
  const people = $derived(
    s.members.map((m) => ({ id: m.uid, uid: m.uid, name: m.name || m.email, detail: m.email })),
  );

  let filters = $state<ScriptFilters>({});
  let filterControls = $state<ScriptControl[]>([]);
  let fieldControls = $state<ScriptControl[]>([]);
  let kept = $state<number | null>(null);
  let wrote = $state<string | null>(null);
  const fail = (where: string, e: string, line?: number) =>
    (problem = `${where}: ${e}${line ? ` (line ${line})` : ''}`);

  $effect(() => {
    const h = host;
    if (!h) return;
    void h.defaults().then((r) => {
      if (h !== host) return;
      if (r.error !== undefined) return fail('filters()', r.error, r.line);
      filters = r.value;
    });
  });
  $effect(() => {
    const h = host;
    const f = filters;
    const all = tickets;
    if (!h) return;
    void h.filterControls({ filters: f }).then((r) => {
      if (h !== host) return;
      if (r.error !== undefined) return fail('filterRender', r.error, r.line);
      filterControls = r.value;
    });
    void h.apply({ tickets: all, filters: f }).then((r) => {
      if (h !== host || 'stale' in r) return;
      if (r.error !== undefined) return fail('onFilter / onSort', r.error, r.line);
      kept = r.value.keep.size;
    });
  });
  $effect(() => {
    const h = host;
    const t = sample;
    if (!h || !t) return;
    void h.fields({ ticket: t }).then((r) => {
      if (h !== host) return;
      if (r.error !== undefined) return fail('fieldRender', r.error, r.line);
      fieldControls = r.value;
    });
  });
  async function tryChange(c: { id: string; value: unknown; allDay?: boolean }) {
    if (!host || !sample) return;
    const r = await host.change({ ticket: sample, ...c });
    if (r.error !== undefined) return fail('onFieldChange', r.error, r.line);
    wrote = r.value
      ? JSON.stringify(r.value, null, 2)
      : 'nothing (onFieldChange returned no patch)';
  }

  // ── save ──
  async function save() {
    if (!s.isAdmin || busy) return;
    busy = true;
    try {
      await command(
        'templateSave',
        {
          boardId: s.board.id,
          templateId: SCRIPT_TEMPLATE_ID,
          template: {
            kind: 'script',
            name: 'Board script',
            code,
            description: "This board's ticket fields, filters and sort, as code.",
          },
        },
        { toast: false },
      );
      previewCode = code;
      toast.success('Board script saved');
    } catch (e) {
      toast.error('Could not save the script', isAppError(e) ? e.message : undefined);
    } finally {
      busy = false;
    }
  }
  function reset(to: 'default' | 'generated') {
    const c = to === 'default' ? DEFAULT_BOARD_SCRIPT : generateBoardScript(s.board);
    code = c;
    previewCode = c;
  }
</script>

<!-- An editor, not a form: the code takes the page; the preview sits beside it. -->
<section class="flex flex-col gap-3" aria-label="Board script">
  <header class="flex flex-wrap items-center gap-2">
    <h2 class="text-xl font-semibold">Script</h2>
    {#if effective?.source === 'generated'}
      <span
        class="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted"
        data-testid="script-generated"
        title="This board has no saved script yet: it runs one generated from its settings, so its tickets show what they showed before. Save to keep it."
        >Generated · not saved</span
      >
    {/if}
    {#if !s.isAdmin}<span class="text-xs text-muted">Read only — admins change the script</span
      >{/if}
    <span class="flex-1"></span>
    <a
      href="/integrate#10-board-script"
      target="_blank"
      rel="noopener"
      class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-text hover:bg-surface-2"
      ><BookOpen size={14} /> Docs</a
    >
    {#if s.isAdmin}
      <Button size="sm" variant="ghost" icon={RotateCcw} onclick={() => reset('default')}
        >Default</Button
      >
      <Button size="sm" variant="ghost" icon={RotateCcw} onclick={() => reset('generated')}
        >From settings</Button
      >
      <Button size="sm" variant="ghost" icon={AlignLeft} onclick={() => editor?.format()}
        >Format</Button
      >
      <Button
        size="sm"
        variant="primary"
        loading={busy}
        disabled={!dirty}
        onclick={save}
        title={errors ? `${errors} error${errors === 1 ? '' : 's'} in the code` : 'Save (⌘S)'}
        >Save</Button
      >
    {/if}
  </header>
  <p class="text-sm text-muted">
    Stage is the app's; every other field on a ticket, the Filter menu and the sort are this code.
    It runs in each person's browser, as them. Agents and the API write tickets without it.
  </p>

  <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
    <div class="flex min-w-0 flex-col gap-2">
      <ScriptEditor
        bind:this={editor}
        value={code}
        readOnly={!s.isAdmin}
        onchange={onCode}
        onsave={save}
        onproblems={(p) =>
          (problems = [...p].sort((a, b) =>
            a.severity === b.severity ? a.line - b.line : a.severity === 'error' ? -1 : 1,
          ))}
        class="h-[calc(100dvh-15rem)] min-h-[26rem]"
      />
      <!-- Problems: the editor's type-check against the script's API; a line is a button. -->
      <div
        class="max-h-28 overflow-auto rounded-md border border-line px-2 py-1 text-xs"
        data-testid="script-problems"
      >
        {#each problems.slice(0, 50) as p, i (i)}
          <button
            type="button"
            class="flex w-full items-start gap-1.5 py-0.5 text-left hover:bg-surface-2"
            onclick={() => editor?.jump(p.line, p.column)}
          >
            {#if p.severity === 'error'}<CircleAlert
                size={12}
                class="mt-0.5 shrink-0 text-danger"
              />{:else}<TriangleAlert size={12} class="mt-0.5 shrink-0 text-warning" />{/if}
            <span class="shrink-0 font-mono text-subtle">{p.line}:{p.column}</span>
            <span class="min-w-0">{p.message}</span>
          </button>
        {:else}
          <p class="py-0.5 text-subtle">
            No problems. Type a hook's name (fieldRender, previewTicketTable, previews…) for a
            snippet; hover any name for its docs.
          </p>
        {/each}
      </div>
    </div>

    <div
      class="flex min-w-0 flex-col gap-3 xl:h-[calc(100dvh-12rem)] xl:min-h-[28rem] xl:overflow-y-auto"
      data-testid="script-preview"
    >
      {#if problem}
        <div role="alert" class="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          {problem}
        </div>
      {/if}
      <div class="rounded-lg border border-line p-3">
        <div class="mb-2 flex items-center justify-between text-xs font-medium text-muted">
          <span>Filters</span>
          {#if kept !== null}<span data-testid="script-kept"
              >{kept} of {tickets.length} tickets shown</span
            >{/if}
        </div>
        <ScriptControls
          layout="bar"
          controls={filterControls}
          {people}
          onchange={(c) => (filters = { ...filters, [c.id]: c.value })}
        />
      </div>
      <div class="@container rounded-lg border border-line p-3">
        <div class="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-muted">
          <span>Ticket fields</span>
          {#if tickets.length}
            <select
              class="h-7 max-w-56 rounded-md border border-line bg-surface px-1.5 text-xs"
              aria-label="Preview with ticket"
              value={sample?.id ?? ''}
              onchange={(e) => (sampleId = e.currentTarget.value)}
            >
              {#each tickets.slice(0, 100) as t (t.id)}<option value={t.id}
                  >{t.key} · {t.title}</option
                >{/each}
            </select>
          {/if}
        </div>
        {#if sample}
          <div class="flex flex-col gap-2.5">
            <ScriptControls
              controls={fieldControls}
              {people}
              commitments={sample.commitments ?? {}}
              onchange={(c) => void tryChange(c)}
            />
          </div>
          {#if wrote}
            <div class="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs">
              <p class="font-medium">Would write (not written):</p>
              <pre
                class="mt-1 max-h-48 overflow-auto font-mono"
                data-testid="script-wrote">{wrote}</pre>
            </div>
          {/if}
        {:else}
          <p class="text-sm text-subtle">Create a ticket to preview its fields here.</p>
        {/if}
      </div>
      <details class="rounded-md border border-line" open={logs.length > 0}>
        <summary class="cursor-pointer px-3 py-1.5 text-xs font-medium text-muted"
          >Console {logs.length ? `(${logs.length})` : ''}</summary
        >
        <ol class="max-h-40 overflow-auto px-3 pb-2 font-mono text-xs">
          {#each logs as l, i (i)}
            <li
              class={l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warning' : ''}
            >
              {l.text}
            </li>
          {:else}
            <li class="text-subtle">console.log(…) from the script shows here.</li>
          {/each}
        </ol>
      </details>
    </div>
  </div>
</section>
