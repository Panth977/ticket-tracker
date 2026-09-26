<!--
  "12 tickets are still in Review — move them to: [Done ▾]". Asked when
  boardUpdate refuses to drop a stage / priority that is in use (409).
  const to = await remap.ask({ kind: 'stage', name: 'Review', count: 12, choices });
-->
<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';

  type Choice = { id: string; name: string };
  let open = $state(false);
  let q = $state<{
    kind: 'stage' | 'priority';
    name: string;
    count: number;
    choices: Choice[];
  } | null>(null);
  let pick = $state('');
  let resolve: ((v: string | null) => void) | null = null;

  export function ask(question: NonNullable<typeof q>): Promise<string | null> {
    resolve?.(null);
    q = question;
    pick = question.choices[0]?.id ?? '';
    open = true;
    return new Promise((r) => (resolve = r));
  }
  function done(v: string | null) {
    const r = resolve;
    resolve = null;
    open = false;
    r?.(v);
  }
</script>

<Dialog
  bind:open
  title={q ? `Where should its tickets go?` : ''}
  size="sm"
  onclose={() => done(null)}
  description={q
    ? `${q.count} ticket${q.count === 1 ? ' is' : 's are'} still ${q.kind === 'stage' ? 'in' : 'marked'} “${q.name}”. Choose a ${q.kind} to move ${q.count === 1 ? 'it' : 'them'} to before it is removed.`
    : undefined}
>
  {#if q}
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Move to</span>
      <select bind:value={pick} class="h-9 rounded-md border border-line bg-surface px-2">
        {#each q.choices as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
      </select>
    </label>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => done(null)}>Cancel</Button>
    <Button variant="primary" disabled={!pick} onclick={() => done(pick)}>Move and save</Button>
  {/snippet}
</Dialog>
