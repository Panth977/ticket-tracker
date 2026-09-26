<!--
  'All boards I'm on / only these…' — used by Personal tokens and OAuth
  consent. `value` null = every board (including ones you join later).
-->
<script lang="ts">
  import { auth } from '$lib/firebase/auth.svelte';
  import { myBoards } from '$lib/stores';
  import { Checkbox, Skeleton } from '$lib/ui';
  import { uid } from '$lib/ui';

  interface Props {
    value?: string[] | null;
    label?: string;
  }
  let { value = $bindable(null), label = 'Boards' }: Props = $props();

  const name = uid('boards');
  const boardsQ = $derived(myBoards(auth.uid));
  const boards = $derived(
    $boardsQ.data.filter((b) => b.archivedAt == null).sort((a, b) => a.name.localeCompare(b.name)),
  );

  function toggle(id: string, on: boolean) {
    const cur = (value ?? []).filter((x) => x !== id);
    value = on ? [...cur, id] : cur;
  }
</script>

<fieldset class="flex flex-col gap-2">
  <legend class="mb-1 text-sm font-medium">{label}</legend>
  <label class="flex items-center gap-2 text-sm">
    <input
      type="radio"
      {name}
      checked={value === null}
      onchange={() => (value = null)}
      class="accent-[var(--tm-accent)]"
    />
    All boards I’m on <span class="text-xs text-muted">(and ones I join later)</span>
  </label>
  <label class="flex items-center gap-2 text-sm">
    <input
      type="radio"
      {name}
      checked={value !== null}
      onchange={() => (value = value ?? [])}
      class="accent-[var(--tm-accent)]"
    />
    Only these…
  </label>
  {#if value !== null}
    <div
      class="ml-6 flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border border-line p-2"
    >
      {#if $boardsQ.loading}
        <Skeleton lines={2} />
      {:else if !boards.length}
        <p class="text-xs text-muted">You’re not on any boards yet.</p>
      {:else}
        {#each boards as b (b.id)}
          <Checkbox
            checked={value.includes(b.id)}
            onchange={(e) => toggle(b.id, (e.currentTarget as HTMLInputElement).checked)}
          >
            <span class="font-mono text-xs text-muted">{b.key}</span>
            {b.name}
          </Checkbox>
        {/each}
      {/if}
    </div>
    {#if !value.length}<p class="ml-6 text-xs text-danger">Pick at least one board.</p>{/if}
  {/if}
</fieldset>
