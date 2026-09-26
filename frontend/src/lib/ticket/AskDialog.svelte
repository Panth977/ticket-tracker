<!--
  ASK A QUESTION (agents.html §N1) — the composer's builder, the person's half
  of the question card an agent posts through the API.

    Start from:  [Yes / No] [Pick one] [Pick several] [Free text]
    Title …                               │  Preview
    Context (optional, rich text)         │  ┌──────────────────┐
    Field 1  [Single choice ▾] ↑ ↓ ✕      │  │ ❓ Which database? │
      Label …            ☐ Required       │  │ ○ Postgres        │
      Options  • Postgres  ↑ ↓ ✕          │  │ ○ SQLite          │
               + Add option               │  │ [Submit]          │
    + Add field                           │  └──────────────────┘
    Who should answer · Blocking · Expires

  The preview is the REAL card (QuestionCard in preview mode), so what is on
  the right is exactly what the thread will render. Ask posts through the
  outbox like any message: the card shows in the thread at once and rolls back
  if the server refuses.
-->
<script lang="ts">
  import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-svelte';
  import { type Question, type RichText, type RichTextDoc } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { isEmptyDoc, plainText, RichEditor, normalizeDoc } from '$lib/editor';
  import { principalChoices } from '$lib/people';
  import ChoicePicker from '$lib/views/pickers/ChoicePicker.svelte';
  import { Button, Checkbox, Dialog, IconButton, Input, Select } from '$lib/ui';
  import { getTicketCtx } from './context';
  import { ticketPickers } from './pickers';
  import { askQuestion } from './pending.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import {
    addField,
    addOption,
    canAddField,
    canAddOption,
    draftIssues,
    emptyDraft,
    EXPIRY_CHOICES,
    FIELD_TYPE_LABELS,
    fieldIssue,
    generalIssues,
    moveField,
    moveOption,
    patchField,
    patchOption,
    previewQuestion,
    removeField,
    removeOption,
    setFieldType,
    TEMPLATES,
    templateDraft,
    toAskInput,
    type AskDraft,
    type ExpiryChoice,
    type TemplateId,
  } from './askBuilder';

  interface Props {
    open: boolean;
    /** Prefill from a failed ask the person reopened, or a slash command. */
    initial?: AskDraft | null;
    onasked?: (messageId: string) => void;
  }
  let { open = $bindable(false), initial = null, onasked }: Props = $props();

  const t = getTicketCtx();
  const pick = ticketPickers(t);
  const people = $derived(principalChoices(t.members));

  // The prefill is read once, when the dialog is built; later changes arrive
  // by reopening it.
  // svelte-ignore state_referenced_locally
  let draft = $state<AskDraft>(initial ?? emptyDraft());
  /** Re-mounts the context editor when a template resets the draft. */
  let resetKey = $state(0);
  let touched = $state(false);
  /** Fixed while the dialog is open, so the preview's expiry does not crawl. */
  let openedAt = $state(Date.now());

  $effect(() => {
    if (open) {
      openedAt = Date.now();
      touched = false;
    }
  });

  const issues = $derived(draftIssues(draft));
  const ok = $derived(issues.length === 0);
  const general = $derived(touched ? generalIssues(issues) : []);
  const issueOf = (id: string) => (touched ? fieldIssue(issues, id) : null);

  /** The context as the card renders it (RichText, not just its doc). */
  const contextText = $derived<RichText | null>(
    draft.body && !isEmptyDoc(draft.body)
      ? {
          doc: normalizeDoc(draft.body),
          text: plainText(draft.body, pick.nameOf),
          mentions: [],
          refs: [],
        }
      : null,
  );
  const preview = $derived<Question>({ ...previewQuestion(draft, openedAt), body: contextText });

  function start(id: TemplateId) {
    draft = { ...templateDraft(id), title: draft.title, body: draft.body };
    resetKey += 1;
  }

  function ask() {
    touched = true;
    if (!ok) return;
    const input = toAskInput(draft, Date.now());
    const id = askQuestion({
      boardId: t.boardId,
      ticketId: t.ticketId,
      ticketKey: t.ticket.key,
      authorUid: t.me,
      authorName: auth.profile?.name || auth.user?.displayName || 'You',
      question: { ...preview, title: input.title, expiresAt: input.expiresAt, to: input.to },
      ask: {
        ...input,
        body: draft.body && !isEmptyDoc(draft.body) ? (draft.body as RichTextDoc) : null,
      },
    });
    open = false;
    draft = emptyDraft();
    resetKey += 1;
    onasked?.(id);
  }
</script>

<Dialog
  bind:open
  size="xl"
  title="Ask a question"
  description="A form card in the thread. Anyone who may comment can answer it."
>
  <div class="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
    <!-- ——— the builder ——— -->
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs font-medium text-muted">Start from</span>
        {#each TEMPLATES as tpl (tpl.id)}
          <button
            type="button"
            title={tpl.hint}
            class="tm-press h-7 rounded-md border border-line px-2 text-xs hover:border-accent hover:bg-surface-2"
            onclick={() => start(tpl.id)}
          >
            {tpl.label}
          </button>
        {/each}
      </div>

      <Input
        label="Question"
        required
        placeholder="Which database should the report use?"
        maxlength={300}
        value={draft.title}
        error={touched && !draft.title.trim() ? 'A question needs a title' : null}
        oninput={(e) => (draft = { ...draft, title: e.currentTarget.value })}
      />

      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-muted"
          >Context <span class="text-subtle">(optional)</span></span
        >
        <div class="rounded-lg border border-line bg-surface focus-within:border-accent">
          {#key resetKey}
            <RichEditor
              value={draft.body}
              label="Context"
              class="max-h-40 overflow-y-auto px-3 py-2 text-sm"
              options={{
                placeholder: 'Anything they need to know — @ to mention, # to link',
                people: pick.people,
                tickets: pick.tickets,
                nameOf: pick.nameOf,
              }}
              onchange={(d) => (draft = { ...draft, body: d })}
            />
          {/key}
        </div>
      </div>

      <!-- ——— fields ——— -->
      <div class="flex flex-col gap-2" data-ask-fields>
        {#each draft.fields as f, i (f.id)}
          {@const bad = issueOf(f.id)}
          <fieldset
            class="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/40 p-2.5"
            data-ask-field={f.id}
          >
            <div class="flex items-center gap-1.5">
              <legend class="sr-only">Field {i + 1}</legend>
              <span class="text-xs font-medium text-muted">Field {i + 1}</span>
              <span class="flex-1"></span>
              <IconButton
                icon={ArrowUp}
                label="Move field {i + 1} up"
                size="sm"
                disabled={i === 0}
                onclick={() => (draft = moveField(draft, f.id, -1))}
              />
              <IconButton
                icon={ArrowDown}
                label="Move field {i + 1} down"
                size="sm"
                disabled={i === draft.fields.length - 1}
                onclick={() => (draft = moveField(draft, f.id, 1))}
              />
              <IconButton
                icon={Trash2}
                label="Remove field {i + 1}"
                size="sm"
                onclick={() => (draft = removeField(draft, f.id))}
              />
            </div>

            <div class="flex flex-wrap items-end gap-2">
              <Input
                label="Label"
                class="min-w-40 flex-1"
                placeholder="Database"
                maxlength={200}
                value={f.label}
                oninput={(e) => (draft = patchField(draft, f.id, { label: e.currentTarget.value }))}
              />
              <Select
                label="Type"
                class="w-40"
                options={FIELD_TYPE_LABELS.map((o) => ({ value: o.value, label: o.label }))}
                value={f.type}
                onchange={(e) =>
                  (draft = setFieldType(
                    draft,
                    f.id,
                    (e.currentTarget as HTMLSelectElement).value as typeof f.type,
                  ))}
              />
            </div>

            {#if f.type === 'single' || f.type === 'multi'}
              <div class="flex flex-col gap-1">
                <span class="text-xs font-medium text-muted">Options</span>
                {#each f.options as o, j (o.id)}
                  <div class="flex items-center gap-1">
                    <Input
                      class="min-w-0 flex-1"
                      aria-label="Option {j + 1}"
                      placeholder="Option {j + 1}"
                      maxlength={120}
                      value={o.label}
                      oninput={(e) =>
                        (draft = patchOption(draft, f.id, o.id, { label: e.currentTarget.value }))}
                    />
                    <IconButton
                      icon={ArrowUp}
                      label="Move option {j + 1} up"
                      size="sm"
                      disabled={j === 0}
                      onclick={() => (draft = moveOption(draft, f.id, o.id, -1))}
                    />
                    <IconButton
                      icon={ArrowDown}
                      label="Move option {j + 1} down"
                      size="sm"
                      disabled={j === f.options.length - 1}
                      onclick={() => (draft = moveOption(draft, f.id, o.id, 1))}
                    />
                    <IconButton
                      icon={Trash2}
                      label="Remove option {j + 1}"
                      size="sm"
                      onclick={() => (draft = removeOption(draft, f.id, o.id))}
                    />
                  </div>
                {/each}
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Plus}
                    disabled={!canAddOption(f)}
                    onclick={() => (draft = addOption(draft, f.id))}>Add option</Button
                  >
                </div>
              </div>
            {/if}

            <Checkbox
              label="Required"
              checked={f.required}
              onchange={(e) =>
                (draft = patchField(draft, f.id, {
                  required: (e.currentTarget as HTMLInputElement).checked,
                }))}
            />
            {#if bad}<p class="text-xs text-danger" role="alert">{bad}</p>{/if}
          </fieldset>
        {/each}
        <div>
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            disabled={!canAddField(draft)}
            onclick={() => (draft = addField(draft))}
          >
            Add field
          </Button>
          {#if !canAddField(draft)}<span class="ml-1 text-xs text-subtle"
              >10 is the most a question can ask.</span
            >{/if}
        </div>
      </div>

      <Checkbox
        label="Add an “Anything else?” box"
        checked={draft.allowComment}
        onchange={(e) =>
          (draft = { ...draft, allowComment: (e.currentTarget as HTMLInputElement).checked })}
      />

      <!-- ——— who, blocking, expiry ——— -->
      <div class="flex flex-col gap-2 border-t border-line pt-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium text-muted">Who should answer</span>
          <ChoicePicker
            items={people}
            selected={draft.to}
            multi
            label="Who should answer"
            placeholder="Anyone on the board"
            onchange={(ids) => (draft = { ...draft, to: ids })}
            class="w-fit"
          />
        </div>
        <Checkbox
          label="Blocking"
          description="Puts ❓ Waiting on the ticket and notifies them."
          checked={draft.blocking}
          onchange={(e) =>
            (draft = { ...draft, blocking: (e.currentTarget as HTMLInputElement).checked })}
        />
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-muted">Expires</span>
          <Select
            class="w-40"
            label="Expires"
            options={EXPIRY_CHOICES.map((o) => ({ value: o.value, label: o.label }))}
            value={draft.expires}
            onchange={(e) =>
              (draft = {
                ...draft,
                expires: (e.currentTarget as HTMLSelectElement).value as ExpiryChoice,
              })}
          />
        </div>
      </div>

      {#each general as g (g)}<p class="text-xs text-danger" role="alert">{g}</p>{/each}
    </div>

    <!-- ——— the live preview: the real card, doing nothing ——— -->
    <div class="flex min-w-0 flex-col gap-1.5">
      <span class="text-xs font-medium text-muted">Preview</span>
      <div class="pointer-events-none select-none" aria-hidden="true" data-ask-preview>
        <QuestionCard messageId="preview" question={preview} preview />
      </div>
    </div>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" disabled={touched && !ok} onclick={ask}>Ask</Button>
  {/snippet}
</Dialog>
