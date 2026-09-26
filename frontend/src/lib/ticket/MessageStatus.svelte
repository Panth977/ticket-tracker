<!--
  The status mark under my messages (agents.html § K): 🕓 on its way, ✓ sent,
  a red ! when it failed. A change of mark cross-fades.
    <MessageStatus mark="sending" />
-->
<script lang="ts">
  import { Check, Clock3 } from 'lucide-svelte';

  export type Mark = 'sending' | 'sent' | 'failed';
  interface Props {
    mark: Mark;
    /** Why it failed (tooltip). */
    error?: string;
  }
  let { mark, error }: Props = $props();
  const title = $derived(
    mark === 'failed'
      ? `Not sent${error ? ` — ${error}` : ''}`
      : mark === 'sent'
        ? 'Sent'
        : 'Sending…',
  );
</script>

<span class="relative inline-grid size-3.5 place-items-center" data-mark={mark} {title}>
  {#key mark}
    <span class="tm-fade-in col-start-1 row-start-1 grid place-items-center">
      {#if mark === 'failed'}
        <span
          class="grid size-3.5 place-items-center rounded-full bg-danger text-[10px] leading-none font-bold text-white"
          role="img"
          aria-label="Not sent">!</span
        >
      {:else if mark === 'sent'}
        <span role="img" aria-label="Sent" class="inline-flex"
          ><Check size={13} class="text-accent" aria-hidden="true" /></span
        >
      {:else}
        <span role="img" aria-label="Sending" class="inline-flex"
          ><Clock3 size={12} class="text-subtle" aria-hidden="true" /></span
        >
      {/if}
    </span>
  {/key}
</span>
