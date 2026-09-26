<!-- Board settings › Analytics: what the board's agents cost, day by day (agents.html §Y3). -->
<script lang="ts">
  import BoardAnalytics from '$lib/cost/BoardAnalytics.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
</script>

<Section
  title="Analytics"
  description="What the agents' turns on this board cost — the receipt each run posts, summed by day and by ticket."
>
  <BoardAnalytics board={s.board} />
</Section>
