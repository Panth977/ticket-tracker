<!--
  Board settings › Subscriptions (bucket.html §D, §J; lib/access): the
  buckets this board uses — EVERY one granted to it, whoever owns it — with
  Read / Write. A board admin adds one of their OWN buckets (both sides must
  agree: bucketGrantSet needs the bucket's owner and a board admin), changes
  what their own bucket grants, and may remove any bucket from the board.
  Below: where ticket attachments go (AttachBucketSettings).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { command } from '$lib/api';
  import { bucketView, type Candidate, type SubscriptionRow } from '$lib/access/entities';
  import { BOARD_BUCKET, can, type Perms } from '$lib/access/relations';
  import SubscriptionList from '$lib/access/SubscriptionList.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { grantOf, ownedBuckets } from '$lib/bucketRefs/owned';
  import type { BoardBucketOut } from '$lib/ticket/attach';
  import { loadBoardBuckets } from '$lib/ticket/boardBuckets';
  import AttachBucketSettings from './AttachBucketSettings.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const boardId = $derived(s.board.id);
  const archived = $derived(s.board.archivedAt != null);

  // My buckets are live (a grant I set shows at once); bucketList answers
  // every bucket granted to the board, and is asked again after each change.
  const ownedQ = $derived(ownedBuckets(auth.uid));
  const owned = $derived(new Map($ownedQ.data.map((m) => [m.id, m])));
  const ownSig = $derived(
    $ownedQ.data.map((m) => `${m.id}:${grantOf(m, { boardId }) ?? ''}`).join(','),
  );
  let listed = $state<BoardBucketOut[] | null>(null);
  let version = $state(0);
  $effect(() => {
    void ownSig;
    void version;
    const id = boardId;
    untrack(() =>
      loadBoardBuckets(id, auth.uid)
        .then((all) => (listed = all))
        .catch(() => (listed = listed ?? [])),
    );
  });

  const rows = $derived.by((): SubscriptionRow[] => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, rebuilt on every change
    const out = new Map<string, SubscriptionRow>();
    const row = (
      id: string,
      view: ReturnType<typeof bucketView>,
      grant: 'read' | 'write' | null | undefined,
    ) => {
      if (!grant) return;
      const ownsBucket = owned.has(id);
      const who = { ownsBucket, boardAdmin: s.isAdmin };
      const attach = s.board.attachBucket?.bucketId === id;
      out.set(id, {
        entity: { ...view, note: attach ? 'ticket attachments go here' : view.note },
        relation: BOARD_BUCKET,
        perms: BOARD_BUCKET.toPerms(grant),
        edit: archived ? 'The board is archived' : can.grantBucketToBoard(who),
        remove: can.revokeBucketFromBoard(who),
      });
    };
    for (const m of listed ?? [])
      row(
        m.id,
        bucketView(m),
        owned.has(m.id) ? grantOf(owned.get(m.id)!, { boardId }) : m.boardGrant,
      );
    for (const m of owned.values())
      if (!out.has(m.id)) row(m.id, bucketView(m), grantOf(m, { boardId }));
    return [...out.values()].sort((a, b) =>
      (a.entity.name ?? '').localeCompare(b.entity.name ?? ''),
    );
  });

  const candidates = $derived<Candidate[]>(
    [...owned.values()]
      .filter((m) => m.archivedAt == null && !rows.some((r) => r.entity.id === m.id))
      .map((m) => ({ entity: bucketView(m), relation: BOARD_BUCKET })),
  );
  const canAdd = $derived(
    !s.isAdmin
      ? 'Only board admins choose which buckets this board uses'
      : archived
        ? 'The board is archived'
        : true,
  );

  async function set(bucketId: string, access: 'read' | 'write' | null, headline: string) {
    try {
      await command('bucketGrantSet', { bucketId, boardId, access }, { toast: headline });
      version++;
      return true;
    } catch {
      return false; // toasted
    }
  }
  const onsave = (c: Candidate, p: Perms) =>
    set(c.entity.id, BOARD_BUCKET.fromPerms(p), 'Could not change bucket access');
  const onremove = (r: SubscriptionRow) => set(r.entity.id, null, 'Could not remove the bucket');
</script>

<div class="flex flex-col gap-10">
  <Section
    title="Subscriptions"
    description="The buckets this board uses. Read: everyone on the board can browse them and attach their files to tickets. Write: editors and admins can also add and change files, and ticket files can go into it. Nobody gets more than their role here allows. You can add buckets you own; any board admin can remove one."
  >
    <SubscriptionList
      name="board"
      {rows}
      {candidates}
      {canAdd}
      loading={listed === null && $ownedQ.loading}
      addTitle="Add a bucket"
      empty="This board uses no bucket yet."
      nothingToAdd="Every bucket you own is already here — or you have none yet (Bucket in the sidebar)."
      removeMessage={() =>
        'Nobody on this board reaches it through the board any more. Its owner can add it again.'}
      {onsave}
      {onremove}
    />
  </Section>
  {#key version}
    <AttachBucketSettings />
  {/key}
</div>
