<!--
  The requires prompt: a drop into a stage whose `requires` fields are missing
  came back 422 { missing, stageId }. Ask for exactly those fields, then retry
  the same move with them merged into the patch — one ticketUpdate.
-->
<script lang="ts">
  import type { FieldValue } from '@tm/shared';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import FieldInput from './FieldInput.svelte';
  import { useBoard, type BoardDoc } from './context.svelte';
  import { updateTicket } from './ops';

  interface Props {
    /** The loaded board (§Q4) — never null. */
    board: BoardDoc;
  }
  let { board }: Props = $props();
  const bs = useBoard();
  const req = $derived(bs.requires);
  let open = $state(false);
  let values = $state<Record<string, FieldValue>>({});
  let busy = $state(false);

  $effect(() => {
    open = req != null;
    if (req)
      values = Object.fromEntries(req.missing.map((id) => [id, req.ticket.fields[id] ?? null]));
  });

  const stageName = $derived(req ? (bs.stage(req.stageId)?.name ?? 'that stage') : '');
  const defs = $derived(
    req
      ? req.missing.map((id) => board.fields.find((f) => f.id === id)).filter((d) => d != null)
      : [],
  );
  const filled = $derived(
    defs.every((d) => {
      const v = values[d.id];
      return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
    }),
  );

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!req || !filled) return;
    busy = true;
    const r = req;
    bs.requires = null;
    await updateTicket(
      bs,
      r.ticket,
      { ...r.patch, fields: { ...r.patch.fields, ...values } },
      { rank: r.rank },
    );
    busy = false;
  }
</script>

<Dialog
  bind:open
  title="{stageName} needs a few fields"
  description={req ? `To move ${req.ticket.key} there, fill these in first.` : undefined}
  onclose={() => (bs.requires = null)}
>
  <form id="requires-form" class="flex flex-col gap-3" onsubmit={submit}>
    {#each defs as def (def.id)}
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">{def.name}</span>
        <FieldInput {def} value={values[def.id]} onchange={(v) => (values[def.id] = v)} />
      </label>
    {:else}
      <p class="text-sm text-muted">
        This stage requires fields that no longer exist — ask an admin to update the stage.
      </p>
    {/each}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (bs.requires = null)}>Cancel</Button>
    <Button variant="primary" type="submit" form="requires-form" loading={busy} disabled={!filled}
      >Move to {stageName}</Button
    >
  {/snippet}
</Dialog>
