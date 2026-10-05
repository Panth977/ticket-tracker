<!--
  WHERE DO THESE FILES GO (memory.html §J). A board takes no files of its own:
  a file put on a ticket goes INTO one of the memories granted `write` to the
  board, at a path, and the ticket points at it. This dialog opens for every
  file added to the composer (📎, paste, drop) with:
    · the memory — the board's attachment default when it has one;
    · one path per file, filled from the board's template
      ('tickets/<ticketId>/<time>_<filename>') with the file's own name
      SELECTED, so typing renames it. Enter attaches.
  A path that is already taken is not an error: the server numbers the new
  file ('name (2).png'). No memory to write to → it says so, and points an
  admin at Settings › Memory.
-->
<script lang="ts">
  // Links come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { tick, untrack } from 'svelte';
  import { Brain, Loader2, Settings, X } from 'lucide-svelte';
  import { formatBytes, memoryGlyph, random6, type BoardAttachMemory } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { KIND_ICON, kindOf } from '$lib/files/kinds';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Select from '$lib/ui/Select.svelte';
  import {
    attachPathProblems,
    defaultMemoryId,
    prefillPath,
    attachLabel,
    type Prefill,
    resolveAttachPath,
    templateFor,
    writeMemories,
    type BoardMemoryOut,
  } from './attach';
  import { loadBoardMemories } from './boardMemories';

  interface Props {
    open: boolean;
    boardId: string;
    boardKey: string;
    /** The ticket's key (ENG-42): fills <ticketId>. */
    ticketKey: string;
    attachMemory: BoardAttachMemory | null | undefined;
    /** Board admins get a way to Settings › Memory when there is nowhere to write. */
    isAdmin: boolean;
    files: File[];
    onattach: (a: {
      memoryId: string;
      memoryName: string;
      list: { file: File; path: string; label: string }[];
    }) => void;
  }
  let {
    open = $bindable(false),
    boardId,
    boardKey,
    ticketKey,
    attachMemory,
    isAdmin,
    files,
    onattach,
  }: Props = $props();

  let memories = $state<BoardMemoryOut[] | null>(null);
  let failed = $state(false);
  let memoryId = $state<string | null>(null);
  let rows = $state<{ file: File; value: string; pre: Prefill }[]>([]);
  let first: HTMLInputElement | null = $state(null);

  // A fresh list every time it opens (grants change elsewhere).
  $effect(() => {
    if (!open) return;
    untrack(() => {
      memories = null;
      failed = false;
      memoryId = null;
      rows = [];
    });
    loadBoardMemories(boardId, auth.uid)
      .then((all) => {
        const list = writeMemories(all, attachMemory);
        memories = list;
        memoryId = defaultMemoryId(list, attachMemory);
      })
      .catch(() => (failed = true));
  });

  // Paths are (re)filled whenever the memory changes: its template applies.
  $effect(() => {
    const id = memoryId;
    if (!id) return;
    untrack(() => void fill(id));
  });

  async function fill(id: string) {
    const template = templateFor(id, attachMemory);
    const at = Date.now();
    const filled = files.map((file) => ({
      file,
      pre: prefillPath(template, { ticketKey, at, random6: random6(), filename: file.name }),
    }));
    rows = filled.map(({ file, pre }) => ({ file, value: pre.value, pre }));
    // Cursor on the first file's own name: typing replaces it.
    await tick();
    const sel = filled[0]?.pre.select;
    if (!first) return;
    first.focus();
    if (sel) first.setSelectionRange(sel[0], sel[1]);
    else first.setSelectionRange(first.value.length, first.value.length);
  }

  const problems = $derived(attachPathProblems(rows.map((r) => r.value)));
  const current = $derived(memories?.find((m) => m.id === memoryId) ?? null);
  const blocked = $derived(!current || !rows.length || problems.some((p) => p));

  function drop(i: number) {
    rows = rows.filter((_, j) => j !== i);
    if (!rows.length) open = false;
  }

  function submit() {
    if (blocked || !current) return;
    const list = rows.map((r) => ({
      file: r.file,
      path: resolveAttachPath(r.value)!,
      label: attachLabel(r.pre, r.value),
    }));
    open = false;
    onattach({ memoryId: current.id, memoryName: current.name, list });
  }
</script>

<Dialog
  bind:open
  title={files.length === 1 ? 'Attach a file' : `Attach ${files.length} files`}
  size="md"
  description="Files on a ticket live in a memory; the ticket points at them. Edit a path to rename a file or put it elsewhere — folders are created, and a taken path gets a number."
>
  <div class="flex flex-col gap-4" data-attach-dialog>
    {#if failed && !memories}
      <p class="text-sm text-danger">Could not load this board's memories.</p>
    {:else if memories === null}
      <p class="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} class="animate-spin" /> Loading…
      </p>
    {:else if !memories.length}
      <div class="flex flex-col items-start gap-3 text-sm" data-attach-none>
        <p class="flex items-start gap-2">
          <Brain size={16} class="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <span>
            Files put on a ticket go into a memory, and no memory is shared with this board for
            writing yet.
          </span>
        </p>
        {#if isAdmin}
          <p class="text-muted">
            Grant one of your memories <b>Read &amp; write</b> to this board, and pick it for ticket attachments.
          </p>
          <a
            href={routes.boardSettings(boardKey, 'memory')}
            class="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-medium hover:bg-surface-2"
            onclick={() => (open = false)}
            data-attach-settings
          >
            <Settings size={14} aria-hidden="true" /> Open Settings › Memory
          </a>
        {:else}
          <p class="text-muted">
            Ask a board admin to share a memory with this board for writing (Settings › Memory).
          </p>
        {/if}
        <p class="text-xs text-subtle">
          “Attach from memory” still attaches files that are already in a memory.
        </p>
      </div>
    {:else}
      <form
        id="ticket-attach"
        class="flex flex-col gap-4"
        onsubmit={(e) => (e.preventDefault(), submit())}
      >
        <Select
          label="Memory"
          bind:value={memoryId}
          options={memories.map((m) => ({
            value: m.id,
            label: `${memoryGlyph(m)} ${m.name}${m.id === attachMemory?.memoryId ? ' (default)' : ''}`,
          }))}
          data-attach-memory
        />
        <ul class="flex max-h-[50vh] flex-col gap-3 overflow-y-auto pr-1">
          {#each rows as r, i (r.file)}
            {@const Icon = KIND_ICON[kindOf({ name: r.file.name, mime: r.file.type })]}
            <li class="flex items-start gap-2" data-attach-row>
              <Icon size={16} class="mt-2 shrink-0 text-muted" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                {#if i === 0}
                  <Input
                    label={rows.length === 1 ? 'Path' : undefined}
                    aria-label="Path for {r.file.name}"
                    bind:value={r.value}
                    bind:ref={first}
                    maxlength={1024}
                    autocomplete="off"
                    spellcheck={false}
                    data-attach-path
                    error={problems[i] ?? undefined}
                  />
                {:else}
                  <Input
                    aria-label="Path for {r.file.name}"
                    bind:value={r.value}
                    maxlength={1024}
                    autocomplete="off"
                    spellcheck={false}
                    data-attach-path
                    error={problems[i] ?? undefined}
                  />
                {/if}
                <p class="mt-1 text-xs text-subtle">{r.file.name} · {formatBytes(r.file.size)}</p>
              </div>
              <button
                type="button"
                class="mt-1.5 grid size-7 shrink-0 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-text"
                aria-label="Don't attach {r.file.name}"
                onclick={() => drop(i)}><X size={14} /></button
              >
            </li>
          {/each}
        </ul>
      </form>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    {#if memories?.length}
      <Button variant="primary" type="submit" form="ticket-attach" disabled={blocked}
        >Attach{rows.length > 1 ? ` ${rows.length}` : ''}</Button
      >
    {/if}
  {/snippet}
</Dialog>
