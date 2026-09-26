<!--
  The description: rendered rich text; editors click to edit (the same editor
  as the composer, with @ and # pickers). Save = ticketUpdate with
  ifUpdatedAt, so a concurrent edit is refused (409) rather than lost.
  A long description collapses to a few lines behind 'Show more' (it sits
  fixed above the thread, agents.html § K).
-->
<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import type { RichTextDoc } from '@tm/shared';
  import { untrack } from 'svelte';
  import { Pencil } from 'lucide-svelte';
  import { outbox } from '$lib/api';
  import { Button, Kbd } from '$lib/ui';
  import {
    Collapsible,
    EditorToolbar,
    isEmptyDoc,
    normalizeDoc,
    RichEditor,
    RichView,
  } from '$lib/editor';
  import { getTicketCtx, updateTicket } from './context';
  import { ticketPickers } from './pickers';

  const t = getTicketCtx();
  const pick = ticketPickers(t);

  let editing = $state(false);
  let doc = $state<RichTextDoc | null>(null);
  let since = 0;
  let editor = $state<Editor | null>(null);

  const current = $derived(t.ticket.description?.doc ?? null);
  const empty = $derived(isEmptyDoc(current));

  function start() {
    if (!t.perms.edit) return;
    doc = current;
    since = t.ticket.updatedAt;
    editing = true;
  }
  /** Saves in the background: the editor closes at once, the overlay shows the new text. */
  function save() {
    const next = doc && !isEmptyDoc(doc) ? normalizeDoc(doc) : null;
    editing = false;
    if (JSON.stringify(next) === JSON.stringify(current ? normalizeDoc(current) : null))
      return true;
    // If it fails, the toast's Open lands back here with the text in the editor.
    void updateTicket(
      t.boardId,
      t.ticketId,
      { description: next },
      { ifUpdatedAt: since, key: t.ticket.key, kind: 'ticketDescription', draft: { doc: next } },
    );
    return true;
  }
  // Open from a failure toast: put the unsaved text back in the editor.
  $effect(() => {
    void outbox.opening;
    untrack(() => {
      const e = outbox.take('ticketDescription', (x) => x.ticketId === t.ticketId);
      if (!e || !t.perms.edit) return;
      outbox.cancel(e.id);
      doc = (e.draft as { doc: RichTextDoc | null } | undefined)?.doc ?? null;
      since = t.ticket.updatedAt;
      editing = true;
    });
  });
  function cancel() {
    editing = false;
    return true;
  }
</script>

{#if editing}
  <div class="rounded-lg border border-accent bg-surface">
    <EditorToolbar {editor} class="border-b border-line px-1.5 py-1" />
    <RichEditor
      value={doc}
      bind:editor
      autofocus
      label="Description"
      class="max-h-[60vh] overflow-y-auto px-3 py-2"
      options={{
        placeholder: 'Describe the work — @ to mention, # to link a ticket',
        people: pick.people,
        tickets: pick.tickets,
        nameOf: pick.nameOf,
        onSubmit: () => (void save(), true),
        onEscape: cancel,
      }}
      onchange={(d) => (doc = d)}
    />
    <div class="flex items-center justify-end gap-2 border-t border-line px-2 py-1.5">
      <span class="mr-auto text-xs text-subtle"
        ><Kbd keys="mod+enter" /> to save · Esc to cancel</span
      >
      <Button size="sm" variant="ghost" onclick={cancel}>Cancel</Button>
      <Button size="sm" variant="primary" onclick={save} class="tm-press">Save</Button>
    </div>
  </div>
{:else if empty}
  {#if t.perms.edit}
    <button
      type="button"
      onclick={start}
      class="-mx-1.5 rounded-md px-1.5 py-1 text-left text-sm text-subtle hover:bg-surface-2"
      >Add a description…</button
    >
  {/if}
{:else}
  <div
    class="group relative -mx-1.5 rounded-md px-1.5 py-1 {t.perms.edit
      ? 'hover:bg-surface-2/60'
      : ''}"
  >
    <Collapsible maxLines={6}>
      <RichView doc={current} ticketHref={t.ticketHref} class="text-sm" />
    </Collapsible>
    {#if t.perms.edit}
      <button
        type="button"
        onclick={start}
        aria-label="Edit description"
        class="absolute top-1 right-1 hidden rounded p-1 text-muted group-hover:block hover:bg-surface-3 hover:text-text focus:block"
      >
        <Pencil size={14} />
      </button>
    {/if}
  </div>
{/if}
