<!--
  The ticket title, edited in place. Saves on Enter / blur with ifUpdatedAt,
  so two people renaming at once get a 409 instead of a silent overwrite.
-->
<script lang="ts">
  import { getTicketCtx, updateTicket } from './context';

  const t = getTicketCtx();
  let draft = $state<string | null>(null);
  let el: HTMLTextAreaElement | undefined = $state();

  const value = $derived(draft ?? t.ticket.title);

  function grow() {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
  $effect(() => {
    void value;
    grow();
  });

  async function commit() {
    if (draft === null) return;
    const title = draft.replace(/\s+/g, ' ').trim();
    const since = t.ticket.updatedAt;
    draft = null;
    if (!title || title === t.ticket.title) return;
    await updateTicket(t.boardId, t.ticketId, { title }, { ifUpdatedAt: since, key: t.ticket.key });
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      el?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      draft = null;
      el?.blur();
    }
  }
</script>

{#if t.perms.edit}
  <textarea
    bind:this={el}
    rows="1"
    maxlength={500}
    aria-label="Title"
    {value}
    oninput={(e) => (draft = e.currentTarget.value)}
    onblur={commit}
    {onkeydown}
    class="-mx-1.5 w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-1.5 py-0.5
      text-xl leading-snug font-semibold hover:border-line focus:border-accent focus:outline-none"
  ></textarea>
{:else}
  <h1 class="text-xl leading-snug font-semibold break-words">{t.ticket.title}</h1>
{/if}
