<!--
  TASK LISTS (agents.html §L2 and §N2) — an agent's plan, and a person's, at
  the top of the right pane, above the fields:

    Task lists                                      + New list
    Plan: add CSV export                             ⋯
    ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░       4 / 7
    ✓ Read the ticket
    ⟳ Run the tests                                      ← doing: highlighted, with a spinner
    ✗ Upload the report                         [⠿ ⋯]    ← the toolbar, on hover / focus
      The export timed out on 40k rows.                  ← the note, under it, full width
      + Add an item

  §P1 (phase 8): the item's text takes the FULL width of the pane. The drag
  handle and the ⋯ menu float over the row's right edge on hover (always
  visible on touch, and on focus for keyboards); the status control keeps its
  place on the left; the bar spans the pane with its count at the end.

  §N2: '+ New list — a title and the items. Paste several lines and each
  becomes an item.' Per list: rename, add, edit in place, drag to reorder,
  delete an item, delete the list. Per item: click the status to cycle
  todo → doing → done, or use its menu for skipped and failed (failed asks for
  a note).

  Who may: editors and admins, and the list's owner — which is how an agent
  keeps ownership of its plan while a person still ticks an item off. Viewers
  and commenters see it read-only, and what they may not do is not drawn.

  Every change goes through the outbox: it shows at once and rolls back if the
  server refuses. One item's status is `tasklistItemUpdate` (no thread line);
  anything structural is a whole-list `tasklistSet`.
-->
<script lang="ts">
  import { flip } from 'svelte/animate';
  import { dragHandle, dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import {
    ArrowDown,
    ArrowUp,
    ChevronDown,
    Circle,
    CircleCheck,
    CircleSlash,
    CircleX,
    GripVertical,
    Loader2,
    MoreHorizontal,
    Pencil,
    Plus,
    Trash2,
    X,
  } from 'lucide-svelte';
  import { can } from '@tm/shared/logic/index';
  import { paths, type TaskItem, type TaskItemStatus, type Tasklist } from '@tm/shared';
  import { outbox } from '$lib/api';
  import { PrincipalAvatar } from '$lib/people';
  import { routes } from '$lib/layout/routes';
  import { Button, Dialog, IconButton, Menu, Textarea, type MenuItem } from '$lib/ui';
  import type { WithId } from '$lib/stores';
  import { getTicketCtx } from './context';
  import { ticketTasklists } from './data';
  import {
    canTick,
    collapseView,
    cycleStatus,
    ITEM_MENU_STATUSES,
    itemLook,
    listIssue,
    loadExpanded,
    localListId,
    moveItem,
    optimisticItems,
    parseItems,
    pendingLists,
    saveExpanded,
    sortLists,
    statusNeedsNote,
    TASKLIST_KIND,
    tasklistProgress,
    toDrafts,
    toItemInputs,
    withItem,
    type ItemDraft,
    type ListEntry,
  } from './tasklist';

  const t = getTicketCtx();
  const lists = $derived(ticketTasklists(t.boardId, t.ticketId));
  const stored = $derived(sortLists($lists.data));
  /** Lists queued but not yet delivered by the listener (a brand-new list). */
  const queued = $derived(
    pendingLists(
      outbox.entries as unknown as ListEntry[],
      t.ticketId,
      t.me,
      new Set(stored.map((l) => l.id)),
    ),
  );
  const rows = $derived([
    ...stored.map((l) => ({ list: l, pending: null as null | 'sending' | 'failed' })),
    ...queued.map((p) => ({ list: p.list as WithId<Tasklist>, pending: p.state })),
  ]);

  /** May I change THIS list (§N2: editors and admins, and its owner)? */
  const mayEdit = (l: Pick<Tasklist, 'owner'>) =>
    !!t.board && canTick({ actor: t.me }, t.board, l, t.perms.closed);
  /** May I start one? Creating is editor work (§N2: 'Viewers and commenters see it read-only'). */
  const mayCreate = $derived(
    !!t.board && !t.perms.closed && can({ actor: t.me }, t.board, 'tasklist'),
  );

  const ticketHref = $derived(routes.ticket(t.ticket.key));

  // ——— writes, all through the outbox ———————————————————————————————————————

  /** One item's status / note: the hot path, and the only write with no thread line. */
  function setItem(
    l: WithId<Tasklist>,
    item: TaskItem,
    patch: { status?: TaskItemStatus; note?: string | null },
  ) {
    if (!mayEdit(l)) return;
    const now = Date.now();
    outbox.queue(
      'tasklistItemUpdate',
      { boardId: t.boardId, ticketId: t.ticketId, listId: l.id, itemId: item.id, ...patch },
      {
        kind: 'ticket',
        label: `update “${item.title}”`,
        openTo: ticketHref,
        optimistic: {
          path: paths.tasklist(t.boardId, t.ticketId, l.id),
          patch: { items: withItem(l.items, item.id, patch, now), updatedAt: now },
        },
      },
    );
  }

  /** The whole list: a rename, an added / edited / removed item, a reorder. */
  function saveList(
    l: WithId<Tasklist>,
    next: { title?: string; items?: ItemDraft[] },
    label: string,
  ) {
    if (!mayEdit(l)) return;
    const title = (next.title ?? l.title).trim();
    const items = next.items ?? toDrafts(l.items);
    if (listIssue(title, items)) return;
    const now = Date.now();
    outbox.queue(
      'tasklistSet',
      { boardId: t.boardId, ticketId: t.ticketId, listId: l.id, title, items: toItemInputs(items) },
      {
        kind: TASKLIST_KIND,
        label,
        openTo: ticketHref,
        boardId: t.boardId,
        ticketId: t.ticketId,
        optimistic: {
          path: paths.tasklist(t.boardId, t.ticketId, l.id),
          patch: { title, items: optimisticItems(items, now, localListId), updatedAt: now },
        },
      },
    );
  }

  function deleteList(l: WithId<Tasklist>) {
    if (!mayEdit(l)) return;
    outbox.queue(
      'tasklistDelete',
      { boardId: t.boardId, ticketId: t.ticketId, listId: l.id },
      {
        kind: TASKLIST_KIND,
        label: `delete “${l.title}”`,
        openTo: ticketHref,
        boardId: t.boardId,
        ticketId: t.ticketId,
        // null hides the document while the delete is in flight.
        optimistic: { path: paths.tasklist(t.boardId, t.ticketId, l.id), patch: null },
      },
    );
  }

  // ——— new list ————————————————————————————————————————————————————————————
  let newOpen = $state(false);
  let newTitle = $state('');
  let newItems = $state('');
  const newParsed = $derived(parseItems(newItems));
  const newIssue = $derived(newTitle.trim() ? null : 'A list needs a title');

  function createList() {
    if (newIssue || !mayCreate) return;
    const listId = localListId();
    const title = newTitle.trim();
    outbox.queue(
      'tasklistSet',
      {
        boardId: t.boardId,
        ticketId: t.ticketId,
        listId,
        title,
        items: newParsed.map((x) => ({ title: x })),
      },
      {
        kind: TASKLIST_KIND,
        label: `add the list “${title}”`,
        openTo: ticketHref,
        boardId: t.boardId,
        ticketId: t.ticketId,
        // No optimistic overlay: a document that does not exist yet cannot be
        // patched, so the pane draws a stand-in from the entry (pendingLists).
      },
    );
    newOpen = false;
    newTitle = '';
    newItems = '';
  }

  // ——— renaming a list / editing an item in place ———————————————————————————
  /** '{listId}' while its title is being edited. */
  let renaming = $state<string | null>(null);
  /** '{listId}:{itemId}' while that item's text is being edited. */
  let editing = $state<string | null>(null);
  /** Per list: the 'add an item' box that is open. */
  let adding = $state<string | null>(null);

  // ——— the note a failed item asks for ——————————————————————————————————————
  let noteFor = $state<{ list: WithId<Tasklist>; item: TaskItem } | null>(null);
  let noteText = $state('');
  function askNote(l: WithId<Tasklist>, item: TaskItem) {
    noteFor = { list: l, item };
    noteText = item.note ?? '';
  }
  function saveNote() {
    const n = noteFor;
    if (!n) return;
    setItem(n.list, n.item, { status: 'failed', note: noteText.trim() || null });
    noteFor = null;
    noteText = '';
  }

  /**
   * §P1: the row's only visible controls are the drag handle and this menu, so
   * everything else an item can do lives in here — the statuses that are not on
   * the click-cycle, 'Move up / Move down' (what a keyboard uses now that the
   * arrows are gone from the row), editing the text and removing the item.
   */
  function itemMenu(l: WithId<Tasklist>, item: TaskItem, index: number): MenuItem[] {
    const statuses: MenuItem[] = ITEM_MENU_STATUSES.map((s) => ({
      label: itemLook(s).label,
      disabled: item.status === s,
      onSelect: () =>
        statusNeedsNote(s) ? askNote(l, item) : setItem(l, item, { status: s, note: null }),
    }));
    return [
      ...statuses,
      {
        label: 'Move up',
        icon: ArrowUp,
        separator: true,
        disabled: index === 0,
        onSelect: () => bump(l, index, -1),
      },
      {
        label: 'Move down',
        icon: ArrowDown,
        disabled: index === l.items.length - 1,
        onSelect: () => bump(l, index, 1),
      },
      {
        label: 'Edit text',
        icon: Pencil,
        separator: true,
        onSelect: () => (editing = `${l.id}:${item.id}`),
      },
      {
        label: 'Remove item',
        icon: Trash2,
        danger: true,
        onSelect: () =>
          saveList(
            l,
            { items: toDrafts(l.items).filter((i) => i.id !== item.id) },
            `remove “${item.title}”`,
          ),
      },
    ];
  }

  function listMenu(l: WithId<Tasklist>): MenuItem[] {
    return [
      { label: 'Rename list', icon: Pencil, onSelect: () => (renaming = l.id) },
      { label: 'Add an item', icon: Plus, onSelect: () => (adding = l.id) },
      {
        label: 'Delete list',
        icon: Trash2,
        danger: true,
        separator: true,
        onSelect: () => deleteList(l),
      },
    ];
  }

  // ——— the fold (§11B) ——————————————————————————————————————————————————————
  /*
   * Which lists are open, remembered for the session (a reading preference,
   * not a setting). Collapsed is the default, so a 20-item plan reads like the
   * TUI: the step that is running, the next few to-dos, and chips for the rest.
   */
  let expanded = $state<string[]>(loadExpanded());
  const isExpanded = (id: string) => expanded.includes(id);
  function setExpanded(id: string, on: boolean) {
    expanded = on ? [...expanded.filter((x) => x !== id), id] : expanded.filter((x) => x !== id);
    saveExpanded(expanded);
  }

  // ——— drag to reorder ——————————————————————————————————————————————————————
  /** One item per line — what the box shows before anything is typed. */
  const ITEMS_PLACEHOLDER = 'Read the spec\nWrite it\nTest it';

  const FLIP = 150;
  /** The list being dragged and its items mid-drag (dnd needs a local copy). */
  let dragId = $state<string | null>(null);
  let dragItems = $state<TaskItem[]>([]);
  const itemsOf = (l: WithId<Tasklist>, rows: TaskItem[]) => (dragId === l.id ? dragItems : rows);

  function consider(l: WithId<Tasklist>, e: CustomEvent<DndEvent<TaskItem>>) {
    dragId = l.id;
    dragItems = e.detail.items;
  }
  function finalize(l: WithId<Tasklist>, e: CustomEvent<DndEvent<TaskItem>>) {
    dragId = null;
    dragItems = [];
    saveList(l, { items: toDrafts(e.detail.items) }, `reorder “${l.title}”`);
  }
  function bump(l: WithId<Tasklist>, index: number, dir: -1 | 1) {
    saveList(l, { items: moveItem(toDrafts(l.items), index, index + dir) }, `reorder “${l.title}”`);
  }
</script>

{#if rows.length || mayCreate}
  <section class="flex flex-col gap-2 border-b border-line px-4 py-3" aria-label="Task lists">
    <header class="flex items-center gap-2">
      <h3 class="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">Task lists</h3>
      {#if mayCreate}
        <Button size="sm" variant="ghost" icon={Plus} onclick={() => (newOpen = true)}
          >New list</Button
        >
      {/if}
    </header>

    {#each rows as row (row.list.id)}
      {@const l = row.list}
      {@const p = tasklistProgress(l)}
      {@const view = collapseView(l, isExpanded(l.id))}
      {@const editable = row.pending === null && mayEdit(l)}
      <article
        class="flex flex-col gap-1.5 rounded-lg border bg-surface-2/40 p-2.5
          {row.pending === 'failed' ? 'border-danger' : 'border-line'} {row.pending === 'sending'
          ? 'opacity-70'
          : ''}"
        data-tasklist={l.id}
      >
        <header class="flex items-center gap-1.5">
          <PrincipalAvatar id={l.owner} size={18} />
          {#if renaming === l.id}
            <input
              class="h-7 min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 text-xs outline-none"
              value={l.title}
              maxlength={200}
              aria-label="List title"
              onblur={(e) => {
                const v = e.currentTarget.value.trim();
                renaming = null;
                if (v && v !== l.title) saveList(l, { title: v }, `rename “${l.title}”`);
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = l.title;
                  renaming = null;
                }
              }}
              {@attach (el) => el.focus()}
            />
          {:else}
            <h4 class="min-w-0 flex-1 truncate text-xs font-semibold" title={l.title}>{l.title}</h4>
          {/if}
          {#if row.pending === 'sending'}
            <Loader2 size={13} class="shrink-0 animate-spin text-muted" aria-label="Saving" />
          {:else if editable}
            <Menu items={listMenu(l)} placement="bottom-end">
              {#snippet trigger(props)}
                <button
                  {...props}
                  type="button"
                  aria-label="Actions for {l.title}"
                  class="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
                >
                  <MoreHorizontal size={14} />
                </button>
              {/snippet}
            </Menu>
          {/if}
        </header>

        <!--
          The bar: what is behind us (done + skipped). §P1 — it spans the pane
          and the count sits at its end, so the row above is free for the title.
        -->
        <div class="flex items-center gap-2">
          <div
            class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={p.total}
            aria-valuenow={p.settled}
            aria-label="{l.title}: {p.label}"
          >
            <span
              class="block h-full rounded-full transition-[width] duration-300 {p.failed
                ? 'bg-danger'
                : 'bg-accent'}"
              style="width:{Math.round(p.fraction * 100)}%"
            ></span>
          </div>
          <span class="shrink-0 text-xs tabular-nums text-muted" data-progress>{p.label}</span>
        </div>

        <!--
          Only the rows the fold left standing (§11B). The dnd zone is handed
          exactly what is drawn, and dragging is off while rows are hidden —
          a drop would otherwise write the visible items back as the whole
          list and throw the folded ones away.
        -->
        <ul
          class="flex flex-col"
          use:dragHandleZone={{
            items: itemsOf(l, view.rows),
            flipDurationMs: FLIP,
            dragDisabled: !editable || view.collapsed,
            dropTargetStyle: {},
            type: `tasklist-${l.id}`,
          }}
          onconsider={(e) => consider(l, e)}
          onfinalize={(e) => finalize(l, e)}
        >
          {#each itemsOf(l, view.rows) as i (i.id)}
            {@const look = itemLook(i.status)}
            <!-- Move up / down mean the item's place in the WHOLE list, not in the rows on screen. -->
            {@const index = l.items.findIndex((x) => x.id === i.id)}
            <!--
              §P1: the item's text takes the FULL width of the pane. Only the
              status control keeps its place on the left; the drag handle and
              the ⋯ menu are a toolbar floating over the row's right edge, so
              they cost the text nothing. Where there is no hover (touch) the
              toolbar is simply always there, and a keyboard brings it up with
              focus-within.
            -->
            <li
              animate:flip={{ duration: FLIP }}
              class="group/item relative rounded px-1 py-1 text-xs
                {i.status === 'doing' ? 'bg-accent-soft/50' : ''}"
              data-item-status={i.status}
              data-item={i.id}
            >
              <div class="flex items-start gap-1.5">
                {#if editable}
                  <button
                    type="button"
                    class="mt-px shrink-0 rounded text-muted hover:text-text"
                    aria-label="{look.label}: {i.title} — change status"
                    title="Click to move it on ({look.label})"
                    onclick={() => setItem(l, i, { status: cycleStatus(i.status), note: null })}
                  >
                    {#if i.status === 'doing'}<Loader2 size={13} class="animate-spin text-accent" />
                    {:else if i.status === 'done'}<CircleCheck size={13} class="text-success" />
                    {:else if i.status === 'failed'}<CircleX size={13} class="text-danger" />
                    {:else if i.status === 'skipped'}<CircleSlash size={13} class="text-subtle" />
                    {:else}<Circle size={13} />{/if}
                  </button>
                {:else}
                  <span
                    class="mt-px shrink-0 text-muted"
                    title={look.label}
                    aria-label={look.label}
                  >
                    {#if i.status === 'doing'}<Loader2 size={13} class="animate-spin text-accent" />
                    {:else if i.status === 'done'}<CircleCheck size={13} class="text-success" />
                    {:else if i.status === 'failed'}<CircleX size={13} class="text-danger" />
                    {:else if i.status === 'skipped'}<CircleSlash size={13} class="text-subtle" />
                    {:else}<Circle size={13} />{/if}
                  </span>
                {/if}

                {#if editing === `${l.id}:${i.id}`}
                  <input
                    class="h-6 min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 text-xs outline-none"
                    value={i.title}
                    maxlength={300}
                    aria-label="Item text"
                    onblur={(e) => {
                      const v = e.currentTarget.value.trim();
                      editing = null;
                      if (v && v !== i.title)
                        saveList(
                          l,
                          {
                            items: toDrafts(l.items).map((x) =>
                              x.id === i.id ? { ...x, title: v } : x,
                            ),
                          },
                          `rename “${i.title}”`,
                        );
                    }}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        e.currentTarget.value = i.title;
                        editing = null;
                      }
                    }}
                    {@attach (el) => el.focus()}
                  />
                {:else if editable}
                  <!-- Click the text to edit it in place (§N2). -->
                  <button
                    type="button"
                    class="min-w-0 flex-1 cursor-text text-left break-words {look.text}"
                    onclick={() => (editing = `${l.id}:${i.id}`)}
                  >
                    {i.title}
                  </button>
                {:else}
                  <span class="min-w-0 flex-1 break-words {look.text}">{i.title}</span>
                {/if}
              </div>

              <!-- §P1: a note (a failed step's) sits UNDER the item, full width. -->
              {#if i.note}
                <p
                  class="mt-0.5 ml-[1.375rem] break-words text-[11px] {i.status === 'failed'
                    ? 'text-danger'
                    : 'text-subtle'}"
                  data-item-note
                >
                  {i.note}
                </p>
              {/if}

              {#if editable}
                <!--
                  The arrows left the row (§P1) — 'Move up / Move down' are in
                  the ⋯ menu. These two stay for assistive tech and keyboards
                  that would rather not open a menu: they take no width and are
                  never painted.
                -->
                <span class="sr-only">
                  <IconButton
                    icon={ArrowUp}
                    label="Move “{i.title}” up"
                    size="sm"
                    disabled={index === 0}
                    onclick={() => bump(l, index, -1)}
                  />
                  <IconButton
                    icon={ArrowDown}
                    label="Move “{i.title}” down"
                    size="sm"
                    disabled={index === l.items.length - 1}
                    onclick={() => bump(l, index, 1)}
                  />
                </span>
                <!--
                  Faded out rather than removed: it still answers the pointer,
                  so the hover that reveals it and the click that uses it are
                  the same gesture. Nothing below it is reachable at the row's
                  right edge, which is the point — that strip belongs to the
                  controls, it just does not cost the text any width.
                -->
                <span
                  class="absolute top-0.5 right-0.5 z-10 flex items-center gap-0.5 rounded-md border border-line
                    bg-surface px-0.5 opacity-0 shadow-sm transition-opacity
                    group-hover/item:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                  data-item-toolbar
                >
                  <span
                    use:dragHandle
                    aria-label="Reorder {i.title}"
                    class="grid size-6 cursor-grab place-items-center text-subtle hover:text-text"
                  >
                    <GripVertical size={12} />
                  </span>
                  <Menu items={itemMenu(l, i, index)} placement="bottom-end">
                    {#snippet trigger(props)}
                      <button
                        {...props}
                        type="button"
                        aria-label="Actions for {i.title}"
                        class="grid size-6 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
                      >
                        <MoreHorizontal size={13} />
                      </button>
                    {/snippet}
                  </Menu>
                </span>
              {/if}
            </li>
          {/each}
        </ul>

        <!--
          The fold (§11B): '+3 pending  +6 done  +1 failed'. Any chip — or
          'Show all' — opens the whole list; a finished list is a single
          '8 done' row under its title, with the bar above it either way.
        -->
        {#if view.collapsed}
          <div class="flex flex-wrap items-center gap-1" data-tasklist-fold>
            {#each view.chips as c (c.key)}
              <button
                type="button"
                data-chip={c.key}
                aria-expanded="false"
                aria-label="{c.label}, show all {l.items.length} items"
                class="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] tabular-nums hover:bg-surface-3
                  hover:text-text {c.key === 'failed' ? 'text-danger' : 'text-muted'}"
                onclick={() => setExpanded(l.id, true)}
              >
                {c.label}
              </button>
            {/each}
            {#if !view.finished}
              <button
                type="button"
                aria-expanded="false"
                aria-label="Show all {l.items.length} items in {l.title}"
                class="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-text"
                onclick={() => setExpanded(l.id, true)}
              >
                <ChevronDown size={12} /> Show all
              </button>
            {/if}
          </div>
        {:else if view.collapsible}
          <button
            type="button"
            aria-expanded="true"
            aria-label="Show less of {l.title}"
            class="flex items-center gap-0.5 self-start rounded px-1 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-text"
            onclick={() => setExpanded(l.id, false)}
          >
            <ChevronDown size={12} class="rotate-180" /> Show less
          </button>
        {/if}

        {#if editable}
          {#if adding === l.id}
            <form
              class="flex items-center gap-1"
              onsubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem('title') as HTMLInputElement;
                const titles = parseItems(input.value);
                if (titles.length)
                  saveList(
                    l,
                    {
                      items: [
                        ...toDrafts(l.items),
                        ...titles.map((title) => ({ title, status: 'todo' as const })),
                      ],
                    },
                    `add to “${l.title}”`,
                  );
                input.value = '';
                adding = null;
              }}
            >
              <input
                name="title"
                class="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-1.5 text-xs outline-none focus:border-accent"
                placeholder="Add an item…"
                maxlength={300}
                aria-label="New item"
                onblur={() => (adding = null)}
                onkeydown={(e) => e.key === 'Escape' && (adding = null)}
                {@attach (el) => el.focus()}
              />
              <IconButton icon={X} label="Cancel" size="sm" onclick={() => (adding = null)} />
            </form>
          {:else}
            <button
              type="button"
              class="flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
              onclick={() => (adding = l.id)}
            >
              <Plus size={12} /> Add an item
            </button>
          {/if}
        {/if}
      </article>
    {/each}
  </section>
{/if}

<!-- ——— + New list ——————————————————————————————————————————————————————— -->
<Dialog
  bind:open={newOpen}
  title="New task list"
  description="Paste a plan — each line becomes an item."
>
  <div class="flex flex-col gap-3">
    <label class="flex flex-col gap-1 text-xs font-medium text-muted">
      Title
      <input
        bind:value={newTitle}
        maxlength={200}
        placeholder="Plan: add CSV export"
        class="h-8 rounded-md border border-line bg-surface px-2.5 text-sm text-text outline-none focus:border-accent"
      />
    </label>
    <Textarea label="Items" rows={6} bind:value={newItems} placeholder={ITEMS_PLACEHOLDER} />
    <p class="text-xs text-subtle">
      {newParsed.length === 1 ? '1 item' : `${newParsed.length} items`}
    </p>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (newOpen = false)}>Cancel</Button>
    <Button variant="primary" disabled={!!newIssue} onclick={createList}>Add list</Button>
  {/snippet}
</Dialog>

<!-- ——— failed asks for a note (§N2) ————————————————————————————————————— -->
<Dialog
  open={noteFor !== null}
  title="What went wrong?"
  description="A short note goes under the item, in red."
  onclose={() => (noteFor = null)}
>
  <Textarea
    label="Note"
    rows={3}
    bind:value={noteText}
    maxlength={1000}
    placeholder="The export timed out on 40k rows."
  />
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (noteFor = null)}>Cancel</Button>
    <Button variant="primary" onclick={saveNote}>Mark failed</Button>
  {/snippet}
</Dialog>
