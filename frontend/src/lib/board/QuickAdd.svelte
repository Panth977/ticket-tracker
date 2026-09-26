<!--
  Quick add (app.json components › Quick add):
    Fix login redirect @priya !high due:fri #ENG-40 +bug
  Tokens are parsed as you type (shared parseQuickAdd / resolveQuickAdd):
  '@pri' suggests people on this board whose name or email starts so, '!' a
  priority, '+' a tag (unknown names become new tags via tagCreate), 'due:' a
  date, '#KEY-n' a reference. Enter creates; ⇧Enter opens the full form; a
  board with required fields always opens the full form.

  Create never waits (agents.html § K): the ticket goes into the outbox with
  a client-chosen id and shows at once as a pending card; the full form
  closes the instant you press Create (quick add clears and stays open for
  the next one). New '+tags' and '#KEY' references are resolved in the
  background just before sending. If the create fails, the toast's Open
  brings this dialog back with the full form prefilled (`restore`).
-->
<script lang="ts" module>
  import type { TicketPatch } from '@tm/shared';
  export type QuickAddDefaults = Pick<
    TicketPatch,
    'stageId' | 'priorityId' | 'assigneeUids' | 'tagIds' | 'fields' | 'dueAt' | 'dueAllDay'
  >;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { doc, getDoc } from 'firebase/firestore';
  import { paths, type FieldValue, type KeyIndex, type RichTextDoc } from '@tm/shared';
  import {
    parseQuickAdd,
    resolveQuickAdd,
    matchPeople,
    type QuickAddToken,
  } from '@tm/shared/logic/quickAdd';
  import { firstStage } from '@tm/shared/logic/stages';
  import { docFromText } from '@tm/shared/logic/richtext/derive';
  import { command, newClientId, outbox } from '$lib/api';
  import { page } from '$app/state';
  import type { CreateDraft } from './pendingCreate';
  import { getDb } from '$lib/firebase/client';
  import Button from '$lib/ui/Button.svelte';
  import DatePicker from '$lib/ui/DatePicker.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Kbd from '$lib/ui/Kbd.svelte';
  import PersonChip from '$lib/ui/PersonChip.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import ChoicePicker, { type ChoiceItem } from '$lib/views/pickers/ChoicePicker.svelte';
  import { formatDate } from '$lib/views/format';
  import FieldInput from './FieldInput.svelte';
  import { useBoard, type BoardDoc } from './context.svelte';

  interface Props {
    /** The loaded board (§Q4) — never null. */
    board: BoardDoc;
    open: boolean;
    defaults?: QuickAddDefaults;
    /** Reopen the full form with these values (a failed create's Open). */
    restore?: CreateDraft | null;
  }
  let { board, open = $bindable(false), defaults = {}, restore = null }: Props = $props();
  const bs = useBoard();
  const requiredFields = $derived(board.fields.filter((f) => f.required && !f.archived));

  let mode = $state<'quick' | 'full'>('quick');
  let text = $state('');
  let caret = $state(0);
  let input: HTMLInputElement | null = $state(null);
  let pick = $state(0);

  // Full form state.
  let f = $state({
    title: '',
    description: '',
    stageId: '',
    priorityId: null as string | null,
    assigneeUids: [] as string[],
    tagIds: [] as string[],
    dueAt: null as number | null,
    dueAllDay: true,
    startAt: null as number | null,
    estimate: null as number | null,
    fields: {} as Record<string, FieldValue>,
  });

  /** Tags picked from suggestions (names with spaces can't be typed as '+tokens'). */
  let pickedTags = $state<string[]>([]);

  // Reset each time the dialog opens — only on `open`, so live board updates never wipe what is typed.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      text = '';
      pick = 0;
      pickedTags = [];
      mode = requiredFields.length || restore ? 'full' : 'quick';
      resetForm();
      if (restore) f = { ...f, ...restore, fields: { ...restore.fields } };
      queueMicrotask(() => input?.focus());
    });
  });

  /**
   * §Q3 — a ticket with no stage starts in the board's FIRST stage by
   * position (the leftmost column), which is what the column's own '+' does
   * and what "add it to the board" means. Not the first stage that happens to
   * be of category 'todo'.
   */
  const defaultStage = () => firstStage(board).id;
  function resetForm() {
    f = {
      title: '',
      description: '',
      stageId: defaults.stageId ?? defaultStage(),
      priorityId: defaults.priorityId ?? null,
      assigneeUids: defaults.assigneeUids ?? [],
      tagIds: defaults.tagIds ?? [],
      dueAt: defaults.dueAt ?? null,
      dueAllDay: defaults.dueAllDay ?? true,
      startAt: null,
      estimate: null,
      fields: { ...(defaults.fields ?? {}) },
    };
  }

  // ── parsing ──
  const parsed = $derived(parseQuickAdd(text, { now: bs.now, tz: bs.tz, weekStartsOn: 1 }));
  const resolved = $derived(resolveQuickAdd(parsed, board, bs.people));
  /** The token under the caret — drives the suggestion list. */
  const current = $derived.by(
    (): { kind: '@' | '!' | '+'; query: string; tok: { start: number; end: number } } | null => {
      const before = text.slice(0, caret);
      const m = /(^|\s)([@!+])(\S*)$/.exec(before);
      if (!m) return null;
      const start = before.length - m[3]!.length - 1;
      const rest = /^\S*/.exec(text.slice(caret))![0];
      return {
        kind: m[2] as '@' | '!' | '+',
        query: m[3]! + rest,
        tok: { start, end: caret + rest.length },
      };
    },
  );
  const suggestions = $derived.by(
    (): { label: string; insert: string; uid?: string; color?: string; tagId?: string }[] => {
      const c = current;
      if (!c) return [];
      const q = c.query.toLowerCase();
      if (c.kind === '@')
        return (q ? matchPeople(q, bs.people) : bs.people)
          .slice(0, 6)
          .map((p) => ({ label: p.name, insert: `@${p.email}`, uid: p.uid }));
      const list = [...(c.kind === '!' ? board.priorities : board.tags)].sort(
        (a, b) => a.position - b.position,
      );
      return list
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => o.name.toLowerCase().startsWith(q))
        .slice(0, 6)
        .map(({ o, i }) =>
          c.kind === '!'
            ? // '!2' means the second priority — the only way to name one with a space in it.
              {
                label: o.name,
                insert: /\s/.test(o.name) ? `!${i + 1}` : `!${o.name}`,
                color: o.color,
              }
            : { label: o.name, insert: '', color: o.color, tagId: o.id },
        );
    },
  );
  $effect(() => {
    void suggestions;
    pick = 0;
  });

  function apply(s: { insert: string; tagId?: string }) {
    const c = current;
    if (!c) return;
    if (s.tagId && !pickedTags.includes(s.tagId)) pickedTags = [...pickedTags, s.tagId];
    const ins = s.insert ? `${s.insert} ` : '';
    text = `${text.slice(0, c.tok.start)}${ins}${text.slice(c.tok.end).trimStart()}`;
    const pos = c.tok.start + ins.length;
    queueMicrotask(() => {
      input?.setSelectionRange(pos, pos);
      caret = pos;
    });
  }

  function onKey(e: KeyboardEvent) {
    if (suggestions.length && current) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        apply(suggestions[pick]!);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) toFull();
      else createQuick();
    }
  }
  const trackCaret = () => (caret = input?.selectionStart ?? text.length);

  /** ⇧Enter: carry what was typed into the full form. */
  function toFull() {
    const r = resolved;
    f = {
      ...f,
      title: r.title,
      priorityId: r.priorityId ?? f.priorityId,
      assigneeUids: [...new Set([...f.assigneeUids, ...r.assigneeUids])],
      tagIds: [...new Set([...f.tagIds, ...r.tagIds, ...pickedTags])],
      dueAt: r.dueAt ?? f.dueAt,
      dueAllDay: r.dueAt != null ? r.dueAllDay : f.dueAllDay,
    };
    mode = 'full';
  }

  // ── create ──
  async function refsDoc(keys: string[], text: string): Promise<RichTextDoc | undefined> {
    if (!keys.length) return text.trim() ? docFromText(text) : undefined;
    const nodes: { type: string; attrs?: Record<string, unknown>; text?: string }[] = [];
    for (const key of keys) {
      let id = bs.tickets.find((t) => t.key === key)?.id;
      if (!id) {
        try {
          const snap = await getDoc(doc(getDb(), paths.key(key)));
          id = snap.exists() ? (snap.data() as KeyIndex).ticketId : undefined;
        } catch {
          id = undefined;
        }
      }
      if (id)
        nodes.push(
          { type: 'ticketRef', attrs: { ticketId: id, key } },
          { type: 'text', text: ' ' },
        );
    }
    const base = text.trim() ? docFromText(text) : { type: 'doc' as const, content: [] };
    if (!nodes.length) return base.content.length ? base : undefined;
    return {
      type: 'doc',
      content: [
        ...base.content,
        { type: 'paragraph', content: [{ type: 'text', text: 'Related: ' }, ...nodes] },
      ],
    } as RichTextDoc;
  }

  async function ensureTags(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      // A retried create may find the tag already made by the first attempt.
      const have = board.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (have) {
        ids.push(have.id);
        continue;
      }
      const res = await command('tagCreate', { boardId: board.id, name }, { toast: false });
      ids.push(res.tag.id);
    }
    return ids;
  }

  function createQuick() {
    const r = resolved;
    if (!r.title.trim()) return;
    if (r.ambiguousAssignees.length) {
      toast.error(
        `Who is “@${r.ambiguousAssignees[0]!.query}”?`,
        'Pick someone from the suggestions.',
      );
      return;
    }
    const tags = [...new Set([...(defaults.tagIds ?? []), ...r.tagIds, ...pickedTags])];
    const req = {
      title: r.title,
      stageId: defaults.stageId ?? defaultStage(),
      priorityId: r.priorityId ?? defaults.priorityId ?? null,
      assigneeUids: [...new Set([...(defaults.assigneeUids ?? []), ...r.assigneeUids])],
      tagIds: tags,
      dueAt: r.dueAt ?? defaults.dueAt ?? null,
      dueAllDay: r.dueAt != null ? r.dueAllDay : (defaults.dueAllDay ?? true),
      ...(defaults.fields && Object.keys(defaults.fields).length
        ? { fields: defaults.fields }
        : {}),
    };
    const newTags = r.newTags;
    const refs = r.refs;
    create(
      req,
      { ...blankDraft(), ...req, fields: { ...(defaults.fields ?? {}) }, description: '' },
      async (i) => {
        // Resolved in the background, just before sending.
        const newTagIds = newTags.length ? await ensureTags(newTags) : [];
        const description = await refsDoc(refs, '');
        return {
          ...i,
          tagIds: [...new Set([...(i.tagIds as string[]), ...newTagIds])],
          ...(description ? { description } : {}),
        };
      },
    );
    // Stay open for the next one (quick add is for bursts).
    text = '';
    pickedTags = [];
    input?.focus();
  }

  function createFull(e: SubmitEvent) {
    e.preventDefault();
    if (!f.title.trim() || missing.length) return;
    const fields = Object.fromEntries(
      Object.entries(f.fields).filter(([, v]) => v != null && v !== ''),
    );
    const text = f.description;
    create(
      {
        title: f.title.trim(),
        stageId: f.stageId,
        priorityId: f.priorityId,
        assigneeUids: f.assigneeUids,
        tagIds: f.tagIds,
        dueAt: f.dueAt,
        dueAllDay: f.dueAllDay,
        startAt: f.startAt,
        estimate: f.estimate,
        ...(Object.keys(fields).length ? { fields } : {}),
      },
      $state.snapshot(f) as CreateDraft,
      text.trim() ? async (i) => ({ ...i, description: await refsDoc([], text) }) : undefined,
    );
    open = false;
  }

  function blankDraft(): CreateDraft {
    return { ...$state.snapshot(f), title: '', description: '' } as CreateDraft;
  }

  type CreateInput = Omit<Parameters<typeof command<'ticketCreate'>>[1], 'boardId' | 'ticketId'>;
  /** Queue the create; the board shows a pending card for it at once. */
  function create(
    input: CreateInput,
    draft: CreateDraft,
    finish?: (i: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) {
    const ticketId = newClientId();
    const b = board;
    outbox.queue(
      'ticketCreate',
      { boardId: b.id, ticketId, ...input },
      {
        kind: 'ticketCreate',
        label: `create “${input.title}”`,
        draft,
        // Back to this very view (its page reopens the form).
        openTo: page.url.pathname,
        ...(finish ? { prepare: (e) => finish(e.input) } : {}),
        onSuccess: (res) =>
          toast.show({
            kind: 'success',
            message: `Created ${res.key}`,
            action: { label: 'Open', run: () => bs.openTicket(res.key) },
          }),
      },
    );
  }

  const missing = $derived(
    requiredFields.filter((d) => {
      const v = f.fields[d.id];
      return v == null || v === '' || (Array.isArray(v) && v.length === 0);
    }),
  );
  const opts = (
    xs: { id: string; name: string; color?: string; position: number }[],
  ): ChoiceItem[] =>
    [...xs]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ id: o.id, label: o.name, color: o.color }));
  const tokenCls: Record<QuickAddToken['kind'], string> = {
    assignee: 'bg-accent-soft text-accent',
    priority: 'bg-warning-soft text-warning',
    due: 'bg-success-soft text-success',
    ref: 'bg-surface-2 text-muted',
    tag: 'bg-surface-2 text-text',
    text: '',
  };
</script>

<Dialog
  bind:open
  title={mode === 'quick' ? 'New ticket' : `New ticket in ${board.key}`}
  size={mode === 'quick' ? 'md' : 'lg'}
>
  {#if mode === 'quick'}
    <div class="flex flex-col gap-2">
      <div class="relative">
        <input
          bind:this={input}
          bind:value={text}
          class="h-10 w-full rounded-md border border-line bg-surface px-3 text-base outline-none focus:border-accent"
          placeholder="Update onboarding copy @priya !high due:fri #ENG-40 +bug"
          aria-label="Ticket title with tokens"
          name="ticket-quick-add"
          autocomplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          onkeydown={onKey}
          onkeyup={trackCaret}
          onclick={trackCaret}
          oninput={trackCaret}
        />
        {#if suggestions.length && current}
          <ul
            role="listbox"
            class="absolute top-full left-0 z-10 mt-1 w-72 rounded-md border border-line bg-surface p-1 shadow-pop"
          >
            {#each suggestions as s, i (s.insert)}
              <li role="option" aria-selected={i === pick}>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm {i ===
                  pick
                    ? 'bg-surface-2'
                    : ''}"
                  onmousedown={(e) => {
                    e.preventDefault();
                    apply(s);
                  }}
                >
                  {#if s.uid}<PersonChip uid={s.uid} layout="inline" size={18} />
                  {:else}{#if s.color}<span class="size-2 rounded-full" style="background:{s.color}"
                      ></span>{/if}{s.label}{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      <div class="flex min-h-6 flex-wrap items-center gap-1 text-xs">
        {#each parsed.tokens.filter((t) => t.kind !== 'text') as t (t.start)}
          <span class="rounded px-1.5 py-0.5 {tokenCls[t.kind]}">{t.raw}</span>
        {/each}
        {#each pickedTags as id (id)}
          {@const tag = board.tags.find((x) => x.id === id)}
          {#if tag}<button
              type="button"
              class="rounded bg-surface-2 px-1.5 py-0.5"
              title="Remove"
              onclick={() => (pickedTags = pickedTags.filter((x) => x !== id))}
              >+{tag.name} ×</button
            >{/if}
        {/each}
        {#each resolved.assigneeUids as u (u)}<PersonChip
            uid={u}
            layout="compact"
            size={16}
          />{/each}
        {#if resolved.dueAt != null}<span class="text-success"
            >Due {formatDate(resolved.dueAt, bs.tz, {
              allDay: resolved.dueAllDay,
              now: bs.now,
            })}</span
          >{/if}
        {#each resolved.newTags as nt (nt)}<span class="text-muted">new tag “{nt}”</span>{/each}
        {#each resolved.ambiguousAssignees as a (a.query)}<span class="text-danger"
            >@{a.query}: {a.candidates.length ? 'several people' : 'nobody'} — pick one</span
          >{/each}
      </div>
      <p class="text-xs text-muted">
        <Kbd keys="enter" /> create · <Kbd keys="shift+enter" /> full form · <code>@</code> assignee
        · <code>!</code> priority ·
        <code>due:fri</code> · <code>+tag</code> · <code>#KEY-1</code>
      </p>
    </div>
  {:else}
    <form
      id="new-ticket"
      class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[8rem_1fr] sm:items-center"
      onsubmit={createFull}
    >
      <label for="nt-title" class="font-medium">Title</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="nt-title"
        bind:value={f.title}
        required
        maxlength={500}
        autofocus
        class="h-9 rounded-md border border-line bg-surface px-2 outline-none focus:border-accent"
      />
      <label for="nt-desc" class="self-start pt-1 font-medium">Description</label>
      <textarea
        id="nt-desc"
        bind:value={f.description}
        rows="4"
        class="rounded-md border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
      ></textarea>
      <span class="font-medium">Stage</span>
      <ChoicePicker
        items={opts(board.stages)}
        selected={[f.stageId]}
        label="Stage"
        onchange={(v) => v[0] && (f.stageId = v[0])}
        class="w-fit"
      />
      <span class="font-medium">Priority</span>
      <ChoicePicker
        items={opts(board.priorities)}
        selected={f.priorityId ? [f.priorityId] : []}
        allowNone
        label="Priority"
        placeholder="None"
        onchange={(v) => (f.priorityId = v[0] ?? null)}
        class="w-fit"
      />
      <span class="font-medium">Assignees</span>
      <ChoicePicker
        items={bs.peopleChoices}
        selected={f.assigneeUids}
        multi
        label="Assignees"
        placeholder="Nobody"
        onchange={(v) => (f.assigneeUids = v)}
        class="w-fit"
      />
      <span class="font-medium">Tags</span>
      <ChoicePicker
        items={opts(board.tags)}
        selected={f.tagIds}
        multi
        label="Tags"
        placeholder="None"
        onchange={(v) => (f.tagIds = v)}
        class="w-fit"
      />
      <span class="font-medium">Start</span>
      <DatePicker bind:value={f.startAt} withTime={false} tz={bs.tz} label="Start" class="w-fit" />
      <span class="font-medium">Due</span>
      <DatePicker
        bind:value={f.dueAt}
        bind:allDay={f.dueAllDay}
        tz={bs.tz}
        label="Due"
        class="w-fit"
      />
      <label for="nt-est" class="font-medium">Estimate</label>
      <input
        id="nt-est"
        type="number"
        min="0"
        step="any"
        class="h-8 w-28 rounded-md border border-line bg-surface px-2"
        value={f.estimate ?? ''}
        onchange={(e) =>
          (f.estimate = e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
      />
      {#each board.fields
        .filter((d) => !d.archived)
        .sort((a, b) => a.position - b.position) as def (def.id)}
        <span class="font-medium"
          >{def.name}{#if def.required}<span class="text-danger" aria-label="required">
              *</span
            >{/if}</span
        >
        <div>
          <FieldInput {def} value={f.fields[def.id]} onchange={(v) => (f.fields[def.id] = v)} />
        </div>
      {/each}
    </form>
  {/if}
  {#snippet footer()}
    {#if mode === 'quick'}
      <Button variant="ghost" onclick={toFull}>Full form</Button>
      <Button
        variant="primary"
        disabled={!resolved.title.trim()}
        onclick={createQuick}
        class="tm-press">Create</Button
      >
    {:else}
      {#if missing.length}<span class="mr-auto text-xs text-danger"
          >Required: {missing.map((d) => d.name).join(', ')}</span
        >{/if}
      <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
      <Button
        variant="primary"
        type="submit"
        form="new-ticket"
        disabled={!f.title.trim() || missing.length > 0}
        class="tm-press">Create ticket</Button
      >
    {/if}
  {/snippet}
</Dialog>
