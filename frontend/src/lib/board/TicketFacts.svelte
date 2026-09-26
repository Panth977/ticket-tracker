<!--
  The meta row of §P2, drawn from ./summary's `cardFacts`:

    [High] [bug] [Sep 24] [3 pts] [☑ 4/7] [📎 2] [⛔ blocked]

  It is deliberately dumb — the deciding (which facts exist, which are empty
  and never drawn) happened in summary.ts, so the kanban card, the table's
  title cell and My work can all render the same array and agree.
-->
<script lang="ts">
  import { Ban, ListChecks, Loader2, Paperclip } from 'lucide-svelte';
  import Badge from '$lib/ui/Badge.svelte';
  import Avatars from './Avatars.svelte';
  import type { Fact } from './summary';

  interface Props {
    facts: Fact[];
    /** Tighter, single-line rendering for a table cell. */
    inline?: boolean;
    class?: string;
  }
  let { facts, inline = false, class: cls = '' }: Props = $props();
</script>

{#if facts.length}
  <!-- min-w-0 + wrap is what keeps a card readable in the narrowest column. -->
  <span
    class="flex min-w-0 items-center gap-1 {inline ? 'overflow-hidden' : 'flex-wrap'} {cls}"
    data-facts={facts.length}
  >
    {#each facts as f (f.id)}
      {#if f.uids}
        <span class="inline-flex items-center gap-1 text-[11px] text-muted">
          {#if f.label}<span class="text-subtle">{f.label}</span>{/if}
          <Avatars uids={f.uids} size={16} />
        </span>
      {:else}
        <!-- `data-tasks` is how the board's e2e reads the '4/7' chip (§L2). -->
        <span
          title={f.title}
          data-fact={f.kind}
          data-tasks={f.kind === 'tasks' ? f.text : undefined}
        >
          <Badge tone={f.tone} color={f.color}>
            {#if f.icon === 'tasksDoing'}<Loader2
                size={10}
                class="mr-0.5 inline animate-spin"
                aria-hidden="true"
              />
            {:else if f.icon === 'tasks'}<ListChecks
                size={10}
                class="mr-0.5 inline"
                aria-hidden="true"
              />
            {:else if f.icon === 'files'}<Paperclip
                size={10}
                class="mr-0.5 inline"
                aria-hidden="true"
              />
            {:else if f.icon === 'blocked'}<Ban
                size={10}
                class="mr-0.5 inline"
                aria-hidden="true"
              />{/if}
            {#if f.label}<span class="mr-0.5 text-subtle">{f.label}</span>{/if}{f.text}
          </Badge>
        </span>
      {/if}
    {/each}
  </span>
{/if}
