<!--
  This ticket's links (blocks / blocked by / relates / duplicates). ticketUpdate
  takes the FULL new list and writes the inverse on the other ticket.
  <LinksEditor compact />  (field panel)   <LinksEditor /> (Related panel)
-->
<script lang="ts">
  import { Plus } from 'lucide-svelte';
  import { TICKET_LINK_TYPES, type TicketLink, type TicketLinkType } from '@tm/shared';
  import { getTicketCtx, updateTicket } from './context';
  import TicketChip from './TicketChip.svelte';
  import TicketPicker from './TicketPicker.svelte';
  import { LINK_LABEL } from './activity';

  let { compact = false }: { compact?: boolean } = $props();
  const t = getTicketCtx();

  let type = $state<TicketLinkType>('relates');
  const links = $derived(t.ticket.links ?? []);

  function save(next: TicketLink[]) {
    void updateTicket(t.boardId, t.ticketId, { links: next }, { key: t.ticket.key });
  }
  function add(ticketId: string) {
    if (links.some((l) => l.ticketId === ticketId && l.type === type)) return;
    save([...links.filter((l) => l.ticketId !== ticketId), { type, ticketId }]);
  }
  function remove(l: TicketLink) {
    save(links.filter((x) => !(x.ticketId === l.ticketId && x.type === l.type)));
  }
</script>

<div class="flex flex-col items-start gap-1 {compact ? 'px-1' : ''}">
  {#each links as l (l.type + l.ticketId)}
    <TicketChip
      ticketId={l.ticketId}
      label={LINK_LABEL[l.type]}
      onremove={t.perms.edit ? () => remove(l) : undefined}
    />
  {/each}
  {#if t.perms.edit}
    <TicketPicker
      label="Link a ticket"
      exclude={links.map((l) => l.ticketId)}
      onpick={(h) => add(h.ticketId)}
    >
      {#snippet header()}
        <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Link type">
          {#each TICKET_LINK_TYPES as ty (ty)}
            <button
              type="button"
              role="radio"
              aria-checked={type === ty}
              onclick={() => (type = ty)}
              class="rounded-full border px-2 py-0.5 text-xs {type === ty
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line text-muted hover:bg-surface-2'}"
            >
              {LINK_LABEL[ty]}
            </button>
          {/each}
        </div>
      {/snippet}
      {#snippet trigger(p)}
        <button
          type="button"
          {...p}
          class="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
        >
          <Plus size={12} /> Link
        </button>
      {/snippet}
    </TicketPicker>
  {:else if !links.length && compact}
    <span class="text-sm text-subtle">None</span>
  {/if}
</div>
