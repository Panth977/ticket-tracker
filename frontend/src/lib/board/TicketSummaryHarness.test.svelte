<!--
  A card inside a clickable wrapper — exactly how the kanban draws it — so a
  test can prove that using the assignee picker does not also open the ticket
  (§P2: 'without opening the ticket').
-->
<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import TicketSummary from './TicketSummary.svelte';

  // The card's own props, plus the wrapper's click — so the spread below is
  // typed exactly as TicketSummary expects it.
  let { oncard, ...rest }: ComponentProps<typeof TicketSummary> & { oncard: () => void } = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div data-card onclick={oncard}>
  <TicketSummary {...rest} />
</div>
