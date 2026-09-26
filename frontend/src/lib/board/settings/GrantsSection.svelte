<!--
  Board settings › Stage grants: commenters can read and talk, and — with a
  grant — move tickets between the stages listed here (e.g. a client who may
  move 'Review' → 'Approved'). Optionally only tickets assigned to them.
-->
<script lang="ts">
  import { paths, type StageGrant } from '@tm/shared';
  import { outbox } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import PersonChip from '$lib/ui/PersonChip.svelte';
  import StageGrantEditor from '../StageGrantEditor.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const commenters = $derived(s.members.filter((m) => m.role === 'commenter'));

  /** In the background, shown at once (an overlay on the board's stageGrants). */
  function set(uid: string, g: StageGrant | null) {
    outbox.queue(
      'boardAccessSet',
      { boardId: s.board.id, stageGrants: { [uid]: g } },
      {
        kind: 'settings:grants',
        label: 'change the stage grant',
        openTo: routes.boardSettings(s.board.key, 'grants'),
        optimistic: { path: paths.board(s.board.id), patch: { [`stageGrants.${uid}`]: g } },
      },
    );
  }
</script>

<Section
  title="Stage grants"
  description="Commenters read and post in threads. A grant also lets them move tickets between the stages you pick — say, a client approving work in Review."
>
  {#if commenters.length === 0}
    <p class="max-w-xl rounded-lg border border-dashed border-line p-5 text-sm text-muted">
      Nobody on this board is a commenter. Give someone the Commenter role in People &amp; roles to
      grant them stages.
    </p>
  {:else}
    <ul
      class="flex max-w-2xl flex-col divide-y divide-line rounded-xl border border-line bg-surface"
    >
      {#each commenters as m (m.uid)}
        <li class="flex flex-wrap items-center gap-3 px-4 py-3">
          <span class="min-w-48 flex-1"><PersonChip uid={m.uid} layout="stacked" /></span>
          <StageGrantEditor
            stages={s.board.stages}
            grant={s.board.stageGrants[m.uid]}
            disabled={s.readOnly}
            onchange={(g) => set(m.uid, g)}
          />
        </li>
      {/each}
    </ul>
  {/if}
</Section>
