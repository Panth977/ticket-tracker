<!--
  Board settings › Subscriptions (memory.html §D, §J; lib/access): the
  memories this board uses — EVERY one granted to it, whoever owns it — with
  Read / Write. A board admin adds one of their OWN memories (both sides must
  agree: memoryGrantSet needs the memory's owner and a board admin), changes
  what their own memory grants, and may remove any memory from the board.
  Below: where ticket attachments go (AttachMemorySettings).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { command } from '$lib/api';
  import { memoryView, type Candidate, type SubscriptionRow } from '$lib/access/entities';
  import { BOARD_MEMORY, can, type Perms } from '$lib/access/relations';
  import SubscriptionList from '$lib/access/SubscriptionList.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { grantOf, ownedMemories } from '$lib/memoryRefs/owned';
  import type { BoardMemoryOut } from '$lib/ticket/attach';
  import { loadBoardMemories } from '$lib/ticket/boardMemories';
  import AttachMemorySettings from './AttachMemorySettings.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const boardId = $derived(s.board.id);
  const archived = $derived(s.board.archivedAt != null);

  // My memories are live (a grant I set shows at once); memoryList answers
  // every memory granted to the board, and is asked again after each change.
  const ownedQ = $derived(ownedMemories(auth.uid));
  const owned = $derived(new Map($ownedQ.data.map((m) => [m.id, m])));
  const ownSig = $derived(
    $ownedQ.data.map((m) => `${m.id}:${grantOf(m, { boardId }) ?? ''}`).join(','),
  );
  let listed = $state<BoardMemoryOut[] | null>(null);
  let version = $state(0);
  $effect(() => {
    void ownSig;
    void version;
    const id = boardId;
    untrack(() =>
      loadBoardMemories(id, auth.uid)
        .then((all) => (listed = all))
        .catch(() => (listed = listed ?? [])),
    );
  });

  const rows = $derived.by((): SubscriptionRow[] => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, rebuilt on every change
    const out = new Map<string, SubscriptionRow>();
    const row = (
      id: string,
      view: ReturnType<typeof memoryView>,
      grant: 'read' | 'write' | null | undefined,
    ) => {
      if (!grant) return;
      const ownsMemory = owned.has(id);
      const who = { ownsMemory, boardAdmin: s.isAdmin };
      const attach = s.board.attachMemory?.memoryId === id;
      out.set(id, {
        entity: { ...view, note: attach ? 'ticket attachments go here' : view.note },
        relation: BOARD_MEMORY,
        perms: BOARD_MEMORY.toPerms(grant),
        edit: archived ? 'The board is archived' : can.grantMemoryToBoard(who),
        remove: can.revokeMemoryFromBoard(who),
      });
    };
    for (const m of listed ?? [])
      row(
        m.id,
        memoryView(m),
        owned.has(m.id) ? grantOf(owned.get(m.id)!, { boardId }) : m.boardGrant,
      );
    for (const m of owned.values())
      if (!out.has(m.id)) row(m.id, memoryView(m), grantOf(m, { boardId }));
    return [...out.values()].sort((a, b) =>
      (a.entity.name ?? '').localeCompare(b.entity.name ?? ''),
    );
  });

  const candidates = $derived<Candidate[]>(
    [...owned.values()]
      .filter((m) => m.archivedAt == null && !rows.some((r) => r.entity.id === m.id))
      .map((m) => ({ entity: memoryView(m), relation: BOARD_MEMORY })),
  );
  const canAdd = $derived(
    !s.isAdmin
      ? 'Only board admins choose which memories this board uses'
      : archived
        ? 'The board is archived'
        : true,
  );

  async function set(memoryId: string, access: 'read' | 'write' | null, headline: string) {
    try {
      await command('memoryGrantSet', { memoryId, boardId, access }, { toast: headline });
      version++;
      return true;
    } catch {
      return false; // toasted
    }
  }
  const onsave = (c: Candidate, p: Perms) =>
    set(c.entity.id, BOARD_MEMORY.fromPerms(p), 'Could not change memory access');
  const onremove = (r: SubscriptionRow) => set(r.entity.id, null, 'Could not remove the memory');
</script>

<div class="flex flex-col gap-10">
  <Section
    title="Subscriptions"
    description="The memories this board uses. Read: everyone on the board can browse them and attach their files to tickets. Write: editors and admins can also add and change files, and ticket files can go into it. Nobody gets more than their role here allows. You can add memories you own; any board admin can remove one."
  >
    <SubscriptionList
      name="board"
      {rows}
      {candidates}
      {canAdd}
      loading={listed === null && $ownedQ.loading}
      addTitle="Add a memory"
      empty="This board uses no memory yet."
      nothingToAdd="Every memory you own is already here — or you have none yet (Memory in the sidebar)."
      removeMessage={() =>
        'Nobody on this board reaches it through the board any more. Its owner can add it again.'}
      {onsave}
      {onremove}
    />
  </Section>
  {#key version}
    <AttachMemorySettings />
  {/key}
</div>
