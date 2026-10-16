<!--
  Board settings › Templates › one template (docs/plan/templates.html §F):
  name, indicator and description; the code; a LIVE PREVIEW that runs the
  code as you type (in the same sandboxed worker the board will use); the
  template's console and its errors (with the line, which is a button); and
  "Try submit", which shows what the template would send without sending it.
  Admins edit; everyone else on the board may read the code.
-->
<script lang="ts">
  // /integrate is a static page beside the SPA, not a route of it.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { untrack } from 'svelte';
  import { ArrowLeft, BookOpen, Play, Trash2 } from 'lucide-svelte';
  import {
    TEMPLATE_STARTERS,
    type Board,
    type Indicator as IndicatorT,
    type TemplateKind,
    type TemplateWithId,
    type Ticket,
  } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { Button, Dialog, Input, Textarea, toast } from '$lib/ui';
  import IndicatorField from '$lib/ui/IndicatorField.svelte';
  import Markdown from '$lib/editor/Markdown.svelte';
  import { boardSources } from './bridge';
  import { memberInfo, ticketInfo } from './info';
  import type { TemplateLog, TemplateProblem } from './host';
  import { checkMessageResult, checkTicketResult, resolveTicket } from './resolve';
  import CodeField from './CodeField.svelte';
  import TemplateForm from './TemplateForm.svelte';
  import CardPreview from './CardPreview.svelte';

  interface Props {
    board: Board & { id: string };
    me: { id: string; name: string; email: string; role: string };
    canEdit: boolean;
    /** null = a new template of `kind`. */
    template: TemplateWithId | null;
    kind: TemplateKind;
    onclose: () => void;
    onsaved?: (templateId: string) => void;
  }
  let { board, me, canEdit, template, kind, onclose, onsaved }: Props = $props();

  const KIND_LABEL: Record<TemplateKind, string> = {
    message: 'Message template',
    ticket: 'Ticket template',
    card: 'Card template',
  };
  const KIND_HELP: Record<TemplateKind, string> = {
    message:
      'A form in the composer (📋). Its submit returns { type: "valid", msg, data } — msg is posted as Markdown, data is kept on the message for agents.',
    ticket:
      'A form in New ticket. Its submit returns { type: "valid", ticket: { title, description, stage, priority, tags, assignees, dueAt, fields } } — named the way people name them.',
    card: 'What each card shows on a kanban view that uses it (Layout › Card). render gets ctx.ticket.',
  };

  // ── the draft ──
  let name = $state('');
  let description = $state('');
  let indicator = $state<IndicatorT | undefined>(undefined);
  let code = $state('');
  let previewCode = $state('');
  let busy = $state(false);
  let confirmDelete = $state(false);
  $effect(() => {
    const t = template;
    untrack(() => {
      name = t?.name ?? '';
      description = t?.description ?? '';
      indicator = t?.indicator;
      code = t?.code ?? TEMPLATE_STARTERS[kind];
      previewCode = code;
      logs = [];
      tried = null;
    });
  });
  const dirty = $derived(
    !template ||
      name !== template.name ||
      (description || null) !== (template.description ?? null) ||
      code !== template.code ||
      JSON.stringify(indicator ?? null) !== JSON.stringify(template.indicator ?? null),
  );

  // The preview restarts 600 ms after you stop typing.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  function onCode(c: string) {
    code = c;
    clearTimeout(debounce);
    debounce = setTimeout(() => (previewCode = c), 600);
  }

  // ── preview data: the board's tickets ──
  const src = $derived(boardSources(board.id, me.id));
  const ticketsStore = $derived(src.tickets);
  const membersStore = $derived(src.members);
  const tickets = $derived($ticketsStore.data);
  let sampleId = $state<string | null>(null);
  const sample = $derived<(Ticket & { id: string }) | null>(
    tickets.find((t) => t.id === sampleId) ?? tickets[0] ?? null,
  );
  const sampleInfo = $derived(
    sample
      ? ticketInfo(sample, board, new Map($membersStore.data.map((m) => [m.uid, memberInfo(m)])))
      : null,
  );

  // ── console ──
  let logs = $state<TemplateLog[]>([]);
  let problem = $state<TemplateProblem | null>(null);
  let codeField: CodeField | undefined = $state();
  const addLog = (l: TemplateLog) => (logs = [...logs.slice(-49), l]);

  // ── try submit ──
  let form: TemplateForm | undefined = $state();
  let ready = $state(false);
  let tried = $state<{ ok: boolean; title: string; md?: string; json?: string } | null>(null);
  async function trySubmit() {
    if (!form) return;
    const r = await form.submit();
    if (r.error) {
      tried = { ok: false, title: `submit threw${r.line ? ` (line ${r.line})` : ''}: ${r.error}` };
      return;
    }
    if (kind === 'message') {
      const c = checkMessageResult(r.result);
      if (c.kind === 'valid') {
        form.setErrors({});
        tried = {
          ok: true,
          title: 'Would post:',
          md: c.value.msg,
          json: c.value.data !== undefined ? JSON.stringify(c.value.data, null, 2) : undefined,
        };
      } else if (c.kind === 'invalid') {
        form.setErrors(c.errors);
        tried = { ok: false, title: `Refused: ${c.errMsg || 'see the fields'}` };
      } else tried = { ok: false, title: c.message };
    } else {
      const c = checkTicketResult(r.result);
      if (c.kind === 'valid') {
        form.setErrors({});
        const res = resolveTicket(c.value, board, $membersStore.data.map(memberInfo), {
          now: Date.now(),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        tried = res.problems.length
          ? { ok: false, title: res.problems.join(' · ') }
          : {
              ok: true,
              title: `Would create “${res.input.title}”${res.newTags.length ? ` (new tags: ${res.newTags.join(', ')})` : ''}:`,
              md: res.description || undefined,
              json: JSON.stringify(res.input, null, 2),
            };
      } else if (c.kind === 'invalid') {
        form.setErrors(c.errors);
        tried = { ok: false, title: `Refused: ${c.errMsg || 'see the fields'}` };
      } else tried = { ok: false, title: c.message };
    }
  }

  // ── save / delete ──
  async function save() {
    if (!canEdit || !name.trim() || busy) return;
    busy = true;
    try {
      const res = await command(
        'templateSave',
        {
          boardId: board.id,
          ...(template ? { templateId: template.id } : {}),
          template: {
            kind,
            name: name.trim(),
            code,
            description: description.trim() || null,
            ...(indicator ? { indicator } : {}),
          },
        },
        { toast: false },
      );
      previewCode = code;
      toast.success(template ? 'Template saved' : `Created “${name.trim()}”`);
      onsaved?.(res.templateId);
    } catch (e) {
      toast.error('Could not save the template', isAppError(e) ? e.message : undefined);
    } finally {
      busy = false;
    }
  }
  async function remove() {
    if (!template) return;
    busy = true;
    try {
      await command(
        'templateDelete',
        { boardId: board.id, templateId: template.id },
        { toast: false },
      );
      toast.success(`Deleted “${template.name}”`);
      confirmDelete = false;
      onclose();
    } catch (e) {
      toast.error('Could not delete the template', isAppError(e) ? e.message : undefined);
    } finally {
      busy = false;
    }
  }

  const previewTemplate = $derived({ id: template?.id ?? 'draft', kind, code: previewCode });
</script>

<section class="flex flex-col gap-4" aria-label="Template editor">
  <header class="flex flex-wrap items-center gap-3 border-b border-line pb-3">
    <button
      type="button"
      class="flex items-center gap-1.5 text-sm text-muted hover:text-text"
      onclick={onclose}><ArrowLeft size={14} /> Templates</button
    >
    <span class="text-xs tracking-wide text-subtle uppercase">{KIND_LABEL[kind]}</span>
    <span class="flex-1"></span>
    <!-- The docs are a static page beside the app (generated, scripts/gen-integration.mjs). -->
    <a
      href="/integrate#9-templates"
      target="_blank"
      rel="noopener"
      class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-text hover:bg-surface-2"
      ><BookOpen size={14} /> Docs</a
    >
    {#if canEdit && template}
      <Button variant="ghost" size="sm" icon={Trash2} onclick={() => (confirmDelete = true)}
        >Delete</Button
      >
    {/if}
    {#if canEdit}
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        disabled={!name.trim() || !dirty}
        onclick={save}>{template ? 'Save' : 'Create'}</Button
      >
    {/if}
  </header>

  <p class="text-sm text-muted">{KIND_HELP[kind]}</p>
  {#if !canEdit}
    <p class="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
      Only board admins can change templates. You can read the code and try it.
    </p>
  {/if}

  <div class="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end">
    <IndicatorField bind:value={indicator} seed={template?.id ?? name} disabled={!canEdit} />
    <Input label="Name" bind:value={name} maxlength={60} required disabled={!canEdit} />
  </div>
  <Textarea
    label="Description"
    bind:value={description}
    rows={2}
    maxlength={2000}
    disabled={!canEdit}
    hint="Plain text: what it is for. Agents read it."
  />

  <div class="grid min-h-[34rem] gap-4 lg:grid-cols-2">
    <div class="flex min-w-0 flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted">Code</span>
        <span class="text-xs text-subtle">⌘S saves</span>
      </div>
      <CodeField
        bind:this={codeField}
        value={code}
        readOnly={!canEdit}
        onchange={onCode}
        onsave={save}
        class="h-[32rem]"
      />
    </div>

    <div class="flex min-w-0 flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted">Preview</span>
        {#if tickets.length}
          <select
            class="h-7 max-w-64 rounded-md border border-line bg-surface px-1.5 text-xs"
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
      {#if problem}
        <div role="alert" class="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          <b>{problem.phase === 'timeout' ? 'Stopped' : `${problem.phase} error`}</b>
          {#if problem.line}
            · <button
              type="button"
              class="underline"
              onclick={() => codeField?.jump(problem!.line!)}>line {problem.line}</button
            >{/if}: {problem.message}
        </div>
      {/if}
      <div class="rounded-lg border border-line bg-surface-2 p-4" data-testid="template-preview">
        {#if kind === 'card'}
          <CardPreview
            code={previewCode}
            templateId={template?.id ?? 'draft'}
            {board}
            {me}
            ticket={sample}
            onlog={addLog}
            onproblem={(p) => (problem = p)}
          />
        {:else}
          <div class="rounded-md bg-surface p-4">
            <TemplateForm
              bind:this={form}
              bind:ready
              template={previewTemplate}
              {board}
              {me}
              ticket={kind === 'message' ? sampleInfo : null}
              onlog={addLog}
              onproblem={(p) => (problem = p)}
              showProblem={false}
            />
            <div class="mt-4 flex justify-end">
              <Button size="sm" icon={Play} disabled={!ready} onclick={trySubmit}>Try submit</Button
              >
            </div>
          </div>
          {#if tried}
            <div
              class="mt-3 rounded-md border px-3 py-2 text-sm {tried.ok
                ? 'border-success/40 bg-success-soft'
                : 'border-danger/40 bg-danger-soft text-danger'}"
              data-testid="template-tried"
            >
              <p class="font-medium">{tried.title}</p>
              {#if tried.md}<div class="mt-2 rounded bg-surface p-2">
                  <Markdown source={tried.md} breaks />
                </div>{/if}
              {#if tried.json}<pre
                  class="mt-2 max-h-48 overflow-auto rounded bg-surface p-2 font-mono text-xs">{tried.json}</pre>{/if}
            </div>
          {/if}
        {/if}
      </div>
      <details class="rounded-md border border-line" open={logs.length > 0}>
        <summary class="cursor-pointer px-3 py-1.5 text-xs font-medium text-muted"
          >Console {logs.length ? `(${logs.length})` : ''}</summary
        >
        <ol
          class="max-h-40 overflow-auto px-3 pb-2 font-mono text-xs"
          data-testid="template-console"
        >
          {#each logs as l, i (i)}
            <li
              class={l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warning' : ''}
            >
              {l.text}
            </li>
          {:else}
            <li class="text-subtle">console.log(…) from the template shows here.</li>
          {/each}
        </ol>
      </details>
    </div>
  </div>
</section>

<Dialog bind:open={confirmDelete} title="Delete “{template?.name}”?" size="sm">
  <p class="text-sm text-muted">
    {kind === 'card'
      ? 'Views that draw their cards with it go back to the built-in card.'
      : 'Messages and tickets it already made stay as they are.'}
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmDelete = false)}>Cancel</Button>
    <Button variant="danger" loading={busy} onclick={remove}>Delete</Button>
  {/snippet}
</Dialog>
