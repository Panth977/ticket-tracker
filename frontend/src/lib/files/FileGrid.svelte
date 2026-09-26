<!--
  Attachments as preview cards in a grid — under a message and in the
  drawer's Files tab (agents.html §H).
    <FileGrid files={m.attachments} onopen={(f) => viewer.open(…)} hrefFor={(f) => …} />
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import FileCard from './FileCard.svelte';
  import type { ViewerFile } from './types';

  interface Props {
    files: readonly ViewerFile[];
    onopen?: (file: ViewerFile) => void;
    hrefFor?: (file: ViewerFile) => string | null;
    disabled?: boolean;
    /** Card width floor (px); the grid fills the row with as many as fit. */
    min?: number;
    class?: string;
    extra?: Snippet<[ViewerFile]>;
  }
  let {
    files,
    onopen,
    hrefFor,
    disabled = false,
    min = 168,
    class: cls = '',
    extra,
  }: Props = $props();
</script>

<ul
  class="grid gap-2 {cls}"
  style="grid-template-columns:repeat(auto-fill,minmax(min({min}px,100%),1fr))"
  aria-label="Files"
>
  {#each files as f (f.id)}
    <li class="min-w-0">
      {#if extra}
        <FileCard file={f} {onopen} href={hrefFor?.(f) ?? null} {disabled}>
          {#snippet extra()}{@render extraFor(f)}{/snippet}
        </FileCard>
      {:else}
        <FileCard file={f} {onopen} href={hrefFor?.(f) ?? null} {disabled} />
      {/if}
    </li>
  {/each}
</ul>

{#snippet extraFor(f: ViewerFile)}{@render extra?.(f)}{/snippet}
