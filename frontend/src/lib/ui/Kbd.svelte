<!-- <Kbd keys="mod+k" />  → ⌘K on Mac, Ctrl K elsewhere.  <Kbd keys="c" /> -->
<script lang="ts">
  import { keyParts } from './keys';
  interface Props {
    keys: string;
    class?: string;
  }
  let { keys, class: cls = '' }: Props = $props();
  const parts = $derived(keyParts(keys));
</script>

<span class="inline-flex items-center gap-0.5 {cls}">
  {#each parts as k, i (i)}
    <kbd
      class="inline-grid h-5 min-w-5 place-items-center rounded border border-line bg-surface-2 px-1 font-sans text-[11px] leading-none text-muted"
      >{k}</kbd
    >
  {/each}
</span>
