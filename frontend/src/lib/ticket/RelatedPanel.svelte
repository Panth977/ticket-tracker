<!--
  Related (app.json › Ticket drawer): links — both ends, since ticketUpdate
  writes the inverse onto the other ticket — plus referencedBy, the tickets
  whose description or thread #mentions this one. A referencing ticket on a
  board I can't read is counted: '1 ticket you can't see'.
-->
<script lang="ts">
  import { EyeOff } from 'lucide-svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { getTicketCtx } from './context';
  import type { Located } from './data';
  import LinksEditor from './LinksEditor.svelte';
  import TicketChip from './TicketChip.svelte';

  const t = getTicketCtx();
  const refs = $derived(
    (t.ticket.referencedBy ?? []).filter(
      (id) => !(t.ticket.links ?? []).some((l) => l.ticketId === id),
    ),
  );
  const status = new SvelteMap<string, Located['status']>();
  const hidden = $derived(refs.filter((id) => status.get(id) === 'hidden').length);
  const any = $derived((t.ticket.links?.length ?? 0) > 0 || refs.length > 0);
</script>

{#if any || t.perms.edit}
  <section aria-label="Related tickets" class="flex flex-col gap-1.5">
    <h2 class="text-xs font-medium text-muted">Related</h2>
    <LinksEditor />
    {#if refs.length}
      <div class="flex flex-col items-start gap-1">
        {#each refs as id (id)}
          <TicketChip
            ticketId={id}
            label="referenced by"
            hideHidden
            onstatus={(s) => status.set(id, s)}
          />
        {/each}
        {#if hidden}
          <span class="inline-flex items-center gap-1.5 text-sm text-subtle">
            <EyeOff size={12} aria-hidden="true" /> referenced by {hidden} ticket{hidden === 1
              ? ''
              : 's'} you can't see
          </span>
        {/if}
      </div>
    {/if}
  </section>
{/if}
