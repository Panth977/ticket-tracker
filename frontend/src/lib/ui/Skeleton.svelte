<!--
  A shimmering placeholder shaped like the content it stands for (agents.html § K › Loaders).
  <Skeleton width="60%" height="0.75rem" />  <Skeleton lines={3} />  <Skeleton height="6rem" class="rounded-lg" />
-->
<script lang="ts">
  interface Props {
    width?: string;
    height?: string;
    lines?: number;
    class?: string;
  }
  let { width = '100%', height = '0.875rem', lines = 1, class: cls = 'rounded' }: Props = $props();
</script>

{#if lines > 1}
  <span class="flex w-full flex-col gap-2" aria-hidden="true">
    {#each Array.from({ length: lines }, (_, i) => i) as i (i)}
      <span
        class="tm-skeleton block {cls}"
        style="width:{i === lines - 1 ? '60%' : width};height:{height}"
      ></span>
    {/each}
  </span>
{:else}
  <span
    class="tm-skeleton inline-block {cls}"
    style="width:{width};height:{height}"
    aria-hidden="true"
  ></span>
{/if}
