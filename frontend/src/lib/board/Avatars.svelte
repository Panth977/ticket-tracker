<!-- Overlapping avatars for a list of people (card assignees); names in the tooltips. -->
<script lang="ts">
  import PersonAvatar from './PersonAvatar.svelte';

  interface Props {
    uids: string[];
    max?: number;
    size?: number;
  }
  let { uids, max = 3, size = 20 }: Props = $props();
  const shown = $derived(uids.slice(0, max));
</script>

<span class="flex items-center -space-x-1.5">
  {#each shown as uid (uid)}
    <PersonAvatar {uid} {size} class="ring-2 ring-surface" />
  {/each}
  {#if uids.length > max}
    <span
      class="grid place-items-center rounded-full bg-surface-2 text-[10px] text-muted ring-2 ring-surface"
      style="width:{size}px;height:{size}px">+{uids.length - max}</span
    >
  {/if}
</span>
