<!--
  Board settings › Stages: one stage's rule for an idle ticket (Stage.auto) —
  nothing, archive it, or move it to another stage, after it has sat here
  with no activity for a while. The server's hourly stageRules job applies it.
-->
<script lang="ts">
  import type { Stage, StageAuto } from '@tm/shared';

  interface Props {
    stage: Stage;
    stages: Stage[];
    disabled?: boolean;
    onchange: (auto: StageAuto | undefined) => void;
  }
  let { stage, stages, disabled = false, onchange }: Props = $props();

  const AFTER: { hours: number; label: string }[] = [
    { hours: 1, label: '1 hour' },
    { hours: 6, label: '6 hours' },
    { hours: 12, label: '12 hours' },
    { hours: 24, label: '1 day' },
    { hours: 48, label: '2 days' },
    { hours: 72, label: '3 days' },
    { hours: 24 * 7, label: '1 week' },
    { hours: 24 * 14, label: '2 weeks' },
    { hours: 24 * 30, label: '30 days' },
  ];
  const others = $derived(stages.filter((x) => x.id !== stage.id));
  const auto = $derived(stage.auto);
  /** 'none' | 'archive' | a stage id to move to. */
  const what = $derived(
    !auto ? 'none' : auto.action === 'archive' ? 'archive' : (auto.toStageId ?? 'none'),
  );
  const hours = $derived(auto?.afterHours ?? 24);
  const afterItems = $derived(
    AFTER.some((a) => a.hours === hours) ? AFTER : [...AFTER, { hours, label: `${hours} hours` }],
  );

  function set(w: string, h: number) {
    if (w === 'none') onchange(undefined);
    else if (w === 'archive') onchange({ afterHours: h, action: 'archive' });
    else onchange({ afterHours: h, action: 'move', toStageId: w });
  }
</script>

<span class="flex flex-wrap items-center gap-1.5" data-testid="stage-auto">
  <span class="text-muted">When idle</span>
  <select
    class="h-7 rounded border border-line bg-surface px-1"
    aria-label="What happens to a ticket left idle in {stage.name}"
    value={what}
    {disabled}
    onchange={(e) => set(e.currentTarget.value, hours)}
  >
    <option value="none">nothing happens</option>
    <option value="archive">archive it</option>
    {#each others as o (o.id)}<option value={o.id}>move it to {o.name}</option>{/each}
  </select>
  {#if what !== 'none'}
    <span class="text-muted">after</span>
    <select
      class="h-7 rounded border border-line bg-surface px-1"
      aria-label="How long a ticket sits idle in {stage.name} first"
      value={String(hours)}
      {disabled}
      onchange={(e) => set(what, Number(e.currentTarget.value))}
    >
      {#each afterItems as a (a.hours)}<option value={String(a.hours)}>{a.label}</option>{/each}
    </select>
  {/if}
</span>
