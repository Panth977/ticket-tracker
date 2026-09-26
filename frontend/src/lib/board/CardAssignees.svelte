<!--
  §P2 › bottom right — ASSIGNEES, EDITABLE IN PLACE: "click an avatar (or the
  + when empty) to open the picker and add or remove people and agents without
  opening the ticket. It saves through the outbox, so the card updates at
  once."

  Everything here is read-only unless you may edit: a viewer sees the avatars
  and no picker at all — and when a viewer's ticket has nobody on it, there is
  nothing to draw, so nothing is (an empty fact is never drawn).

  The click must not reach the card underneath, or picking someone would also
  open the ticket.
-->
<script lang="ts">
  import { UserPlus } from 'lucide-svelte';
  import ChoicePicker, { type ChoiceItem } from '$lib/views/pickers/ChoicePicker.svelte';
  import Avatars from './Avatars.svelte';

  interface Props {
    uids: string[];
    /** May I change them? false = avatars only, no picker and no '+'. */
    editable: boolean;
    /** People AND agents on the board (bs.peopleChoices). */
    choices: ChoiceItem[];
    onchange: (uids: string[]) => void;
    size?: number;
    max?: number;
    /** Named for the screen reader: 'Assignees on ENG-42'. */
    label?: string;
  }
  let {
    uids,
    editable,
    choices,
    onchange,
    size = 18,
    max = 3,
    label = 'Assignees',
  }: Props = $props();
</script>

{#if !editable}
  {#if uids.length}<Avatars {uids} {size} {max} />{/if}
{:else}
  <!-- Purely a shield: the picker button inside it carries all the semantics. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="inline-flex shrink-0"
    data-assignees={uids.length}
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <ChoicePicker
      items={choices}
      selected={uids}
      multi
      chevron={false}
      {label}
      class="h-auto rounded-full border-transparent bg-transparent px-0 hover:bg-transparent"
      {onchange}
    >
      {#snippet display()}
        {#if uids.length}
          <Avatars {uids} {size} {max} />
        {:else}
          <!-- Nothing assigned: the '+' IS the empty state — no 'Unassigned' text. -->
          <span
            class="grid place-items-center rounded-full border border-dashed border-line text-subtle hover:border-accent hover:text-accent"
            style="width:{size}px;height:{size}px"
          >
            <UserPlus size={Math.round(size * 0.6)} aria-hidden="true" />
          </span>
        {/if}
      {/snippet}
    </ChoicePicker>
  </span>
{/if}
