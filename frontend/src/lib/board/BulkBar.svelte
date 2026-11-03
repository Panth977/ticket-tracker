<!--
  The bulk bar (board-script.html §bulk): 14 selected · Stage · [the board script's
  bulkRender controls] · Archive. Stage and Archive are the app's own (one
  ticketBulk call; the server skips tickets a commenter's grant does not cover).
  Every other control is the script's: onBulkChange answers one patch for every
  selected ticket, or one per ticket, each written as an ordinary ticketUpdate.
-->
<script lang="ts">
  import { Archive, X } from 'lucide-svelte';
  import type { ScriptControl, TicketPatch } from '@tm/shared';
  import Button from '$lib/ui/Button.svelte';
  import { toast } from '$lib/ui';
  import ChoicePicker from '$lib/views/pickers/ChoicePicker.svelte';
  import ScriptControls from '$lib/templates/ScriptControls.svelte';
  import { useBoard, type BoardDoc } from './context.svelte';
  import { bulk, updateTicket } from './ops';
  import { stageChoices } from './stageMark';

  interface Props {
    /** The loaded board (§Q4) — never null. */
    board: BoardDoc;
    ids: string[];
    onclear: () => void;
  }
  let { board, ids, onclear }: Props = $props();
  const bs = useBoard();
  const editor = $derived(bs.canEdit);
  const picked = $derived(bs.tickets.filter((t) => ids.includes(t.id)));
  const people = $derived(bs.peopleChoices.map((p) => ({ id: p.id, uid: p.id, name: p.label })));

  let controls = $state<ScriptControl[]>([]);
  let seq = 0;
  $effect(() => {
    const h = bs.script;
    const list = picked;
    if (!h || !editor) return;
    const n = ++seq;
    void h.bulkControls({ tickets: list }).then((r) => {
      if (n !== seq) return;
      if (r.error !== undefined) toast.error(`Board script: ${r.error}`);
      else controls = r.value;
    });
  });

  async function change(c: { id: string; value: unknown; allDay?: boolean }) {
    const h = bs.script;
    if (!h) return;
    const r = await h.bulkChange({ tickets: picked, ...c });
    if (r.error !== undefined) {
      toast.error(`Board script: ${r.error}${r.line ? ` (line ${r.line})` : ''}`);
      return;
    }
    if (!r.value) return;
    let n = 0;
    for (const t of picked) {
      const p = r.value.get(t.id);
      if (p && Object.keys(p).length) {
        n++;
        void updateTicket(bs, t, p as TicketPatch);
      }
    }
    if (n) toast.success(`Updated ${n} ticket${n === 1 ? '' : 's'}`);
  }
</script>

<div
  role="toolbar"
  aria-label="Bulk actions"
  class="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-2 text-sm shadow-pop"
>
  <span class="font-medium">{ids.length} selected</span>
  <span class="h-4 w-px bg-line"></span>
  <ChoicePicker
    items={stageChoices(board.stages)}
    selected={[]}
    placeholder="Stage"
    label="Move to stage"
    onchange={(v) => v[0] && bulk(bs, ids, { type: 'stage', stageId: v[0] })}
  />
  {#if editor}
    <div class="flex flex-wrap items-center gap-2" data-testid="script-bulk">
      <ScriptControls layout="inline" {controls} {people} tz={bs.tz} onchange={change} />
    </div>
    <Button
      size="sm"
      variant="ghost"
      icon={Archive}
      onclick={() => bulk(bs, ids, { type: 'state', state: 'archived' }).then(onclear)}
      >Archive</Button
    >
  {/if}
  <button
    type="button"
    class="ml-auto grid size-7 place-items-center rounded text-muted hover:bg-surface-2"
    aria-label="Clear selection"
    onclick={onclear}
  >
    <X size={15} />
  </button>
</div>
