<!-- Board settings › Analytics: the board's aggregate fields, per period and by ticket (aggregates.html). -->
<script lang="ts">
  import AggAnalytics from '$lib/aggregates/AggAnalytics.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
</script>

<Section
  title="Analytics"
  description="What this board's aggregate fields add up to — Cost from the agents' turn receipts, and any field of your own — by period and by ticket."
>
  <AggAnalytics board={s.board} />
</Section>
