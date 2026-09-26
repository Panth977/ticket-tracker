<!--
  Board (app.json screens › Board): /b/[boardKey]/[viewId]?ticket=ENG-42

  ONE BAR (agents.html §Q2) — the board is the page title, its saved views are
  the tabs, and everything that acts on what you are looking at is on the right:

    ● ENG Engineering ☆ │ Board  Table  Mine  +     🔎  Filter 2  Sort  Group: Stage  🔔 Mine  ⚙  + New

    [ Kanban | Table | Calendar | Timeline ]

  LIVE: one onSnapshot per open board over state == 'active'; everything else in
  the view (filter, sort, group, swimlanes) is computed in the browser by the
  shared view engine (applyView) — the same function the REST / MCP doors run.

  §Q4 — NOTHING below this page renders until the board, its views and its
  members are all here: the components take a non-null `board` PROP, so a board
  that is still loading (or was just switched away from) can no longer blank the
  page with "Cannot read properties of null".
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { untrack } from 'svelte';
  import { noteBoardMembers } from '$lib/people';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Archive } from 'lucide-svelte';
  import {
    paths,
    type BoardMember,
    type Read,
    type Ticket,
    type TicketState,
    type ViewInput,
    type ViewType,
  } from '@tm/shared';
  import { applyView, ALL_KEY, NONE_KEY, type ViewGroup } from '@tm/shared/logic/view';
  import { auth } from '$lib/firebase/auth.svelte';
  import { command, outbox } from '$lib/api';
  import { pendingCreates, type CreateDraft } from '$lib/board/pendingCreate';
  import {
    boardActiveTickets,
    boardByKey,
    boardMembers,
    boardPref,
    boardReads,
    boardViews,
    queryStore,
  } from '$lib/stores';
  import { routes } from '$lib/layout/routes';
  import { useShortcut } from '$lib/keyboard';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import TicketDrawer from '$lib/ticket/TicketDrawer.svelte';
  import { stateQueryValues, withReadState } from '$lib/ticket/state';
  import { BoardState, provideBoard, type BoardTicket } from '$lib/board/context.svelte';
  import BoardBar from '$lib/board/BoardBar.svelte';
  import Kanban from '$lib/board/Kanban.svelte';
  import Table from '$lib/board/Table.svelte';
  import Calendar from '$lib/board/Calendar.svelte';
  import Timeline from '$lib/board/Timeline.svelte';
  import QuickAdd, { type QuickAddDefaults } from '$lib/board/QuickAdd.svelte';
  import RequiresPrompt from '$lib/board/RequiresPrompt.svelte';
  import { joinBoard, onlineHere } from '$lib/board/presence';
  import ViewDialog, { type ViewDialogMode } from '$lib/views/ViewDialog.svelte';
  import {
    clearDraft,
    draftKey,
    fallbackView,
    getDraft,
    newViewInput,
    sameView,
    setDraft,
    toInput,
  } from '$lib/views/draft';
  import { andWith, normalize } from '$lib/views/filter';
  import { movePatch } from '$lib/views/move';

  const boardKey = $derived(page.params.boardKey ?? '');
  const viewId = $derived(page.params.viewId ?? '');
  const ticketKey = $derived(page.url.searchParams.get('ticket'));

  // ── live data ───────────────────────────────────────────────────────────
  const boardStore = $derived(boardByKey(auth.uid, boardKey));
  const board = $derived($boardStore.board);
  const boardId = $derived(board?.id ?? null);
  const uid = $derived(auth.uid);

  // §Q4: the state reads the board through a getter over the derived above, so
  // it is current DURING render — not one effect flush later, which is what
  // used to let children draw against a null board.
  const bs = provideBoard(new BoardState(() => board));

  const views = $derived(boardViews(boardId, uid));
  const pref = $derived(boardPref(boardId, uid));
  // The same three queries the boot prewarm opens (§T): shared helpers, so the
  // two spellings cannot drift apart and leave the prewarm warming a key nobody reads.
  const members = $derived(boardMembers(boardId));
  const reads = $derived(boardReads(boardId, uid));
  // §W: incremental — the first open is one query, later opens pay for the delta.
  const active = $derived(boardActiveTickets(boardId, uid));

  /** §Q4 — the board page holds its skeleton until board + views + members are in. */
  const ready = $derived(!!board && !$views.loading && !$members.loading);

  $effect(() => {
    bs.me = uid ?? '';
    bs.tz = auth.profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  });
  $effect(() => {
    bs.members = $members.data;
    // Agents resolve through their members/ row (they have no users/ doc): tell $lib/people.
    if (board?.id && $members.data.length) noteBoardMembers(board.id, $members.data);
  });
  $effect(() => {
    bs.setReads($reads.data);
  });
  $effect(() => {
    const t = setInterval(() => (bs.now = Date.now()), 60_000);
    return () => clearInterval(t);
  });
  $effect(() => {
    if (boardId && uid) return joinBoard(boardId, uid);
  });
  const online = $derived(onlineHere(boardId, uid));

  // ── the open view and its draft ─────────────────────────────────────────
  const saved = $derived($views.data.find((v) => v.id === viewId) ?? null);
  const savedInput = $derived(saved ? toInput(saved) : null);
  const key = $derived(boardId && viewId ? draftKey(boardId, viewId) : '');
  let draft = $state<ViewInput>(newViewInput('kanban', { name: 'Board', scope: 'shared' }));
  /** The saved version the current draft was taken from. */
  let baseline: ViewInput | null = null;
  let loadedKey = '';

  $effect(() => {
    const k = key;
    const s = savedInput;
    untrack(() => {
      if (!k) return;
      if (k !== loadedKey) {
        loadedKey = k;
        baseline = s;
        draft = getDraft(k) ?? s ?? fallbackView(board);
        return;
      }
      if (!s) return;
      // The saved view changed underneath (someone saved it): follow it unless I have edits.
      if (!baseline || sameView(draft, baseline)) draft = s;
      else draft = { ...draft, name: s.name, scope: s.scope, position: s.position };
      baseline = s;
    });
  });

  const dirty = $derived(savedInput ? !sameView(draft, savedInput) : false);
  function change(d: ViewInput) {
    draft = d;
    if (key) setDraft(key, d);
  }

  // Extra listener only while the view asks for archived tickets. The query
  // also asks for the pre-phase-6 'cancelled' value, which still renders (as
  // archived) until scripts/migrate-cancelled.mjs has run.
  const extraStates = $derived(
    draft.includeStates.filter((s): s is Exclude<TicketState, 'active'> => s !== 'active'),
  );
  const extra = $derived(
    queryStore<Ticket>(
      boardId && extraStates.length
        ? { path: paths.tickets(boardId), where: [['state', 'in', stateQueryValues(extraStates)]] }
        : null,
    ),
  );
  $effect(() => {
    const id = boardId ?? '';
    const withId = (t: Ticket & { id: string }): BoardTicket =>
      withReadState({ ...t, boardId: id });
    const live = [
      ...$active.data.map(withId),
      ...(extraStates.length ? $extra.data.map(withId) : []),
    ];
    // Tickets still being created (outbox) show as pending cards until the listener brings them.
    const pc = pendingCreates(outbox.entries, board, uid ?? '', new Set(live.map((t) => t.id)));
    bs.tickets = pc.tickets.length ? [...live, ...pc.tickets] : live;
    bs.pending = pc.state;
    bs.ticketsLoading = $active.loading;
  });

  // A view that no longer exists (deleted, or someone else's personal one) → the board's default.
  $effect(() => {
    if (!board || $views.loading || saved) return;
    if ($views.data.length && viewId !== board.defaultViewId) {
      void goto(routes.board(board.key, board.defaultViewId, ticketKey), { replaceState: true });
    }
  });

  // Remember where I was (prefs/{me}.lastViewId) — once per view opened. The
  // sidebar reads it back: one click lands where I left off (§Q1).
  let rememberedFor = '';
  $effect(() => {
    const p = $pref;
    if (!boardId || !saved || p.loading || rememberedFor === key) return;
    rememberedFor = key;
    if (p.data?.lastViewId === viewId) return;
    void command('boardPrefSet', { boardId, pref: { lastViewId: viewId } }, { toast: false }).catch(
      () => {},
    );
  });

  // ── what the view shows ─────────────────────────────────────────────────
  let search = $state('');
  const spec = $derived({
    ...draft,
    filter: andWith(
      draft.filter,
      search.trim() ? { field: 'text', cmp: 'contains' as const, value: search.trim() } : null,
    ),
  });
  const groups = $derived(board ? applyView(bs.tickets, spec, board, bs.viewCtx) : []);
  const flat = $derived(
    board
      ? (applyView(bs.tickets, { ...spec, groupBy: null, subGroupBy: null }, board, bs.viewCtx)[0]
          ?.tickets ?? [])
      : [],
  );
  const flatGroups = $derived<ViewGroup<BoardTicket>[]>([
    { key: ALL_KEY, by: null, value: null, label: null, tickets: flat },
  ]);

  // ── permissions for the view tab's menu ─────────────────────────────────
  const canSave = $derived(
    !!saved && !bs.archived && (saved.scope === 'personal' ? saved.ownerUid === uid : bs.canEdit),
  );
  const canDelete = $derived(canSave && !!board && viewId !== board.defaultViewId);

  // ── view commands ───────────────────────────────────────────────────────
  let dialogOpen = $state(false);
  let dialogMode = $state<ViewDialogMode>('new');
  /** 'Save as personal view…' vs 'Save as shared view…' pre-pick the scope. */
  let saveAsScope = $state<'personal' | 'shared'>('personal');
  function openDialog(m: ViewDialogMode, scope: 'personal' | 'shared' = 'personal') {
    dialogMode = m;
    saveAsScope = scope;
    dialogOpen = true;
  }
  const nextPosition = () => Math.max(0, ...$views.data.map((v) => v.position)) + 1;

  async function onDialog(v: { name: string; type: ViewType; scope: 'personal' | 'shared' }) {
    if (!boardId || !board) return;
    if (dialogMode === 'rename') {
      if (!saved || !savedInput) return;
      outbox.queue(
        'viewSave',
        { boardId, viewId, view: { ...savedInput, name: v.name } },
        {
          kind: 'view',
          label: `rename the view to “${v.name}”`,
          optimistic: { path: paths.view(boardId, viewId), patch: { name: v.name } },
        },
      );
      return;
    }
    // A new view needs its id before we can go to it: this one waits (the dialog shows it working).
    const view: ViewInput =
      dialogMode === 'new'
        ? newViewInput(v.type, { name: v.name, scope: v.scope, position: nextPosition() })
        : {
            ...draft,
            filter: normalize(draft.filter),
            name: v.name,
            scope: v.scope,
            position: nextPosition(),
          };
    const res = await command('viewSave', { boardId, view }, { toast: 'Could not save the view' });
    if (dialogMode === 'saveAs' && key) {
      clearDraft(key);
      if (savedInput) draft = savedInput;
    }
    toast.success(`Saved “${v.name}”`);
    void goto(routes.board(board.key, res.viewId));
  }

  /** Save the open view: the draft becomes the saved view at once; the write follows. */
  function save() {
    if (!boardId || !saved) return;
    const view = {
      ...draft,
      filter: normalize(draft.filter),
      name: saved.name,
      scope: saved.scope,
      position: saved.position,
    };
    const k = key;
    const prevBaseline = baseline;
    const at = page.url.pathname;
    if (k) clearDraft(k);
    baseline = view;
    outbox.queue(
      'viewSave',
      { boardId, viewId, view },
      {
        kind: 'view',
        label: `save the view “${saved.name}”`,
        openTo: at,
        draft: { key: k, view },
        persist: false,
        optimistic: { path: paths.view(boardId, viewId), patch: { ...view } },
        // Cancel: the unsaved edits come back as a draft.
        rollback: () => {
          baseline = prevBaseline;
          if (k) setDraft(k, view);
        },
        onSuccess: () => toast.success('View saved'),
      },
    );
  }
  function reset() {
    if (key) clearDraft(key);
    draft = savedInput ?? fallbackView(board);
  }
  function del() {
    if (!boardId || !board || !saved) return;
    if (
      !confirm(
        `Delete the view “${saved.name}”? ${saved.scope === 'shared' ? 'It disappears for everyone.' : ''}`,
      )
    )
      return;
    outbox.queue(
      'viewDelete',
      { boardId, viewId },
      {
        kind: 'view',
        label: `delete the view “${saved.name}”`,
        optimistic: { path: paths.view(boardId, viewId), patch: null },
      },
    );
    if (key) clearDraft(key);
    void goto(routes.board(board.key, board.defaultViewId), { replaceState: true });
  }
  function makeDefault() {
    if (!boardId) return;
    outbox.queue(
      'boardUpdate',
      { boardId, patch: { defaultViewId: viewId } },
      {
        kind: 'settings',
        label: 'change the default view',
        optimistic: { path: paths.board(boardId), patch: { defaultViewId: viewId } },
        onSuccess: () => toast.success('Default view changed'),
      },
    );
  }

  // ── header actions ──────────────────────────────────────────────────────
  function toggleStar() {
    if (!boardId || !uid) return;
    const starred = !($pref.data?.starred ?? false);
    outbox.queue(
      'boardPrefSet',
      { boardId, pref: { starred } },
      {
        kind: 'settings',
        label: starred ? 'star the board' : 'unstar the board',
        optimistic: { path: paths.pref(boardId, uid), patch: { starred } },
      },
    );
  }
  function restoreBoard() {
    if (!boardId) return;
    outbox.queue(
      'boardArchive',
      { boardId, action: 'restore' },
      {
        kind: 'settings',
        label: 'restore the board',
        optimistic: { path: paths.board(boardId), patch: { archivedAt: null } },
        onSuccess: () => toast.success('Board restored'),
      },
    );
  }

  let quickOpen = $state(false);
  let quickDefaults = $state<QuickAddDefaults>({});
  let quickRestore = $state<CreateDraft | null>(null);
  function newTicket(defaults: QuickAddDefaults = {}) {
    if (!bs.canCreate) return;
    quickDefaults = defaults;
    quickRestore = null;
    quickOpen = true;
  }
  // A failed create's Open (toast / sync list / its red card): back to the full form, prefilled.
  $effect(() => {
    void outbox.opening;
    if (!board) return;
    const id = board.id;
    untrack(() => {
      const e = outbox.take('ticketCreate', (x) => x.boardId === id);
      if (!e) return;
      outbox.cancel(e.id);
      quickDefaults = {};
      quickRestore = (e.draft as CreateDraft | undefined) ?? null;
      quickOpen = true;
    });
  });
  /** A new ticket from a column's '+': it starts with that column's (and lane's) value. */
  function addIn(col: ViewGroup<BoardTicket>, lane: ViewGroup<BoardTicket> | null) {
    if (!board) return;
    const blank = { stageId: '', priorityId: null, assigneeUids: [], tagIds: [], fields: {} };
    const a = movePatch(draft.groupBy, NONE_KEY, col.key, blank, board) ?? {};
    const b =
      lane && draft.subGroupBy
        ? (movePatch(draft.subGroupBy, NONE_KEY, lane.key, blank, board) ?? {})
        : {};
    newTicket({ ...a, ...b, fields: { ...a.fields, ...b.fields } } as QuickAddDefaults);
  }
  useShortcut('c', () => newTicket(), { description: 'New ticket' });

  function closeTicket() {
    const url = new URL(page.url);
    url.searchParams.delete('ticket');
    void goto(url, { noScroll: true, keepFocus: true });
  }
</script>

<svelte:head
  ><title>{board ? `${board.key} · ${board.name}` : 'Board'} — TaskManager</title></svelte:head
>

{#if !$boardStore.loading && !board}
  <!-- Gone, or I am not on it — a stated empty state, never a crash (§Q4). -->
  <EmptyState
    title="Board not found"
    description="It may have been deleted, or you're not on it. Ask an admin for an invite."
  >
    {#snippet action()}<Button href={routes.home()}>Back to your boards</Button>{/snippet}
  </EmptyState>
{:else if !ready || !board}
  <!-- §Q4: one skeleton until the board, its views AND its members are here. -->
  <div class="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading the board">
    <div class="flex items-center gap-2">
      <Skeleton width="0.7rem" height="0.7rem" class="rounded-full" /><Skeleton
        height="1.25rem"
        width="14rem"
      />
    </div>
    <div class="flex gap-2">
      <Skeleton width="4rem" height="1.6rem" class="rounded-md" /><Skeleton
        width="4rem"
        height="1.6rem"
        class="rounded-md"
      /><Skeleton width="4rem" height="1.6rem" class="rounded-md" />
    </div>
    <div class="mt-2 flex gap-3">
      {#each [3, 2, 3] as n, i (i)}
        <div class="flex w-72 flex-col gap-1.5 rounded-lg bg-surface-2/60 p-1.5">
          {#each Array.from({ length: n }, (_, j) => j) as j (j)}<Skeleton
              height="4.5rem"
              class="rounded-md"
            />{/each}
        </div>
      {/each}
    </div>
  </div>
{:else}
  <div class="flex h-[calc(100dvh-3rem)] min-h-0 flex-col md:h-dvh">
    <BoardBar
      {board}
      views={$views.data}
      {viewId}
      {draft}
      {dirty}
      people={bs.people}
      online={$online}
      me={uid ?? ''}
      pref={$pref.data}
      starred={$pref.data?.starred ?? false}
      {canSave}
      {canDelete}
      canSaveShared={bs.canEdit}
      canCreate={bs.canCreate}
      isAdmin={bs.isAdmin}
      bind:search
      onchange={change}
      onsave={save}
      onsaveas={(scope) => openDialog('saveAs', scope)}
      onreset={reset}
      onrename={() => openDialog('rename')}
      ondelete={del}
      onnew={() => openDialog('new')}
      onmakedefault={makeDefault}
      onstar={toggleStar}
      onnewticket={() => newTicket()}
    />

    {#if bs.archived}
      <div
        role="status"
        class="flex items-center gap-2 bg-warning-soft px-4 py-2 text-sm text-warning"
      >
        <Archive size={14} /> This board is archived — it's read-only and hidden from the sidebar.
        {#if bs.isAdmin}<Button size="sm" class="ml-auto" onclick={restoreBoard}
            >Restore board</Button
          >{/if}
      </div>
    {/if}

    <div class="min-h-0 flex-1 bg-bg">
      {#if $active.loading && bs.tickets.length === 0 && draft.type === 'table'}
        <!-- Table-shaped placeholders. -->
        <div
          class="m-4 flex flex-col divide-y divide-line rounded-lg border border-line bg-surface"
          aria-busy="true"
          aria-label="Loading tickets"
        >
          {#each [0, 1, 2, 3, 4, 5] as i (i)}
            <div class="flex items-center gap-4 px-3 py-2.5">
              <Skeleton width="3.5rem" height="0.75rem" />
              <Skeleton width="{30 + (i % 3) * 12}%" />
              <span class="ml-auto flex gap-4"
                ><Skeleton width="5rem" height="0.75rem" /><Skeleton
                  width="4rem"
                  height="0.75rem"
                /></span
              >
            </div>
          {/each}
        </div>
      {:else if $active.loading && bs.tickets.length === 0}
        <!-- Columns of card-shaped placeholders. -->
        <div
          class="flex h-full gap-3 overflow-hidden p-4"
          aria-busy="true"
          aria-label="Loading tickets"
        >
          {#each [3, 2, 4, 1] as n, i (i)}
            <div class="flex w-72 shrink-0 flex-col gap-1.5 rounded-lg bg-surface-2/60 p-1.5">
              <div class="flex items-center gap-2 px-1.5 pt-1 pb-1.5">
                <Skeleton width="40%" height="0.8rem" /><span class="ml-auto"
                  ><Skeleton width="1.2rem" height="0.8rem" /></span
                >
              </div>
              {#each Array.from({ length: n }, (_, j) => j) as j (j)}
                <div class="flex flex-col gap-2 rounded-md border border-line bg-surface p-2.5">
                  <Skeleton width="30%" height="0.6rem" />
                  <Skeleton width="{70 + ((i + j) % 3) * 10}%" />
                  <div class="flex gap-1">
                    <Skeleton width="3rem" height="1rem" class="rounded-full" /><Skeleton
                      width="2.5rem"
                      height="1rem"
                      class="rounded-full"
                    />
                  </div>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      {:else if $active.error}
        <EmptyState title="Couldn't load tickets" description={$active.error.message} />
      {:else}
        <!-- Switching views cross-fades the content. -->
        {#key `${viewId}:${draft.type}`}
          <div class="tm-fade-in h-full">
            {#if draft.type === 'kanban'}
              <Kanban {board} {groups} view={draft} onadd={addIn} />
            {:else if draft.type === 'table'}
              <Table
                {board}
                groups={draft.groupBy ? groups : flatGroups}
                view={draft}
                onchange={change}
              />
            {:else if draft.type === 'calendar'}
              <Calendar {board} groups={flatGroups} view={draft} onchange={change} />
            {:else}
              <Timeline {board} groups={flatGroups} view={draft} onchange={change} />
            {/if}
          </div>
        {/key}
      {/if}
    </div>
  </div>

  <QuickAdd {board} bind:open={quickOpen} defaults={quickDefaults} restore={quickRestore} />
  <RequiresPrompt {board} />
  <ViewDialog
    bind:open={dialogOpen}
    mode={dialogMode}
    initialName={dialogMode === 'rename'
      ? (saved?.name ?? '')
      : dialogMode === 'saveAs'
        ? `${saved?.name ?? 'View'} (copy)`
        : ''}
    initialScope={dialogMode === 'saveAs' ? saveAsScope : bs.canEdit ? 'shared' : 'personal'}
    canShared={bs.canEdit}
    onsubmit={onDialog}
  />
{/if}

{#if ticketKey}
  <TicketDrawer {ticketKey} onClose={closeTicket} />
{/if}
