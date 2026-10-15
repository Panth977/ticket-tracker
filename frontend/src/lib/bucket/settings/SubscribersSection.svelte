<!--
  Bucket settings › Subscribers (bucket.html §D; lib/access): every board and
  artifact that may use this bucket, with Read / Write — and Remove. Either
  side may end a grant: the bucket's owner, an admin of that board, or the
  owner of that artifact (bucketGrantSet with access null). Adding happens in
  the board's or the artifact's Subscriptions, since a grant needs both sides.
-->
<script lang="ts">
  import type { BucketGrant } from '@tm/shared';
  import { command } from '$lib/api';
  import { artifactView, boardView, hiddenView, type SubscriberRow } from '$lib/access/entities';
  import { ARTIFACT_BUCKET, BOARD_BUCKET, can } from '$lib/access/relations';
  import SubscriberList from '$lib/access/SubscriberList.svelte';
  import { myArtifacts } from '$lib/artifacts/store';
  import Section from '$lib/board/settings/Section.svelte';
  import { myBoards } from '$lib/stores';
  import { useBucketSettings } from './context.svelte';

  const s = useBucketSettings();
  const m = $derived(s.bucket);
  const boardsQ = $derived(myBoards(s.me));
  const artifactsQ = $derived(myArtifacts(s.me));
  const boardById = $derived(new Map($boardsQ.data.map((b) => [b.id, b])));
  const artifactById = $derived(new Map($artifactsQ.data.map((a) => [a.id, a])));

  const rows = $derived.by((): SubscriberRow[] => [
    ...Object.entries(m.boards ?? {}).map(([id, access]): SubscriberRow => {
      const b = boardById.get(id);
      return {
        entity: b ? boardView(b) : hiddenView('board', id),
        chips: BOARD_BUCKET.chips(BOARD_BUCKET.toPerms(access as BucketGrant)),
        remove: can.revokeBucketFromBoard({
          ownsBucket: s.isOwner,
          boardAdmin: b?.access[s.me] === 'admin',
        }),
      };
    }),
    ...Object.entries(m.artifacts ?? {}).map(([id, access]): SubscriberRow => {
      const a = artifactById.get(id);
      return {
        entity: a ? artifactView(a) : hiddenView('artifact', id),
        chips: ARTIFACT_BUCKET.chips(ARTIFACT_BUCKET.toPerms(access as BucketGrant)),
        remove: can.revokeBucketFromArtifact({
          ownsBucket: s.isOwner,
          ownsArtifact: a?.ownerUid === s.me,
        }),
      };
    }),
  ]);

  async function onremove(r: SubscriberRow): Promise<boolean> {
    try {
      await command(
        'bucketGrantSet',
        {
          bucketId: m.id,
          ...(r.entity.kind === 'board' ? { boardId: r.entity.id } : { artifactId: r.entity.id }),
          access: null,
        },
        { toast: 'Could not remove it' },
      );
      return true;
    } catch {
      return false; // toasted; the list shows the live document
    }
  }
</script>

<Section
  title="Subscribers"
  description="The boards and artifacts that may use this bucket. A board's members (people and agents) and an artifact's page reach it only through these, and nobody gets more than their own role allows. They are added from the board's or the artifact's Subscriptions; the bucket's owner — or that board's admin, or that artifact's owner — can remove one."
>
  <SubscriberList
    name="bucket"
    {rows}
    loading={$boardsQ.loading || $artifactsQ.loading}
    empty="Nothing uses this bucket yet. Add it from a board's or an artifact's Settings › Subscriptions."
    removeMessage={(r) =>
      r.entity.kind === 'board'
        ? 'Nobody on that board reaches this bucket through the board any more.'
        : 'That artifact’s page stops reaching this bucket at once.'}
    {onremove}
  />
</Section>
