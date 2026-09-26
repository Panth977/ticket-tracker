<!--
  Name a view: '+ View' (name, layout, who sees it), 'Save as…' (name, who
  sees it) and 'Rename…' (name only).
-->
<script lang="ts" module>
  export type ViewDialogMode = 'new' | 'saveAs' | 'rename';
</script>

<script lang="ts">
  import { VIEW_TYPES, type ViewType } from '@tm/shared';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { VIEW_TYPE_LABEL } from './draft';

  interface Props {
    open: boolean;
    mode: ViewDialogMode;
    initialName?: string;
    initialScope?: 'personal' | 'shared';
    initialType?: ViewType;
    /** Editors may create shared views. */
    canShared: boolean;
    onsubmit: (v: {
      name: string;
      type: ViewType;
      scope: 'personal' | 'shared';
    }) => Promise<void> | void;
  }
  let {
    open = $bindable(false),
    mode,
    initialName = '',
    initialScope = 'personal',
    initialType = 'kanban',
    canShared,
    onsubmit,
  }: Props = $props();

  let name = $state('');
  let type = $state<ViewType>('kanban');
  let scope = $state<'personal' | 'shared'>('personal');
  let busy = $state(false);

  $effect(() => {
    if (open) {
      name = initialName;
      type = initialType;
      scope = canShared ? initialScope : 'personal';
    }
  });

  const title = $derived(
    mode === 'new' ? 'New view' : mode === 'saveAs' ? 'Save as a new view' : 'Rename view',
  );

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    busy = true;
    try {
      await onsubmit({ name: n.slice(0, 60), type, scope });
      open = false;
    } catch {
      /* the command already toasted */
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open {title} size="sm">
  <form id="view-dialog" class="flex flex-col gap-3" onsubmit={submit}>
    <Input label="Name" bind:value={name} maxlength={60} required autofocus />
    {#if mode === 'new'}
      <fieldset class="flex flex-col gap-1 text-sm">
        <legend class="mb-1 font-medium">Layout</legend>
        <div class="grid grid-cols-2 gap-1.5">
          {#each VIEW_TYPES as t (t)}
            <label
              class="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 {type ===
              t
                ? 'border-accent bg-accent-soft'
                : 'border-line'}"
            >
              <input
                type="radio"
                name="view-type"
                value={t}
                bind:group={type}
                class="accent-[var(--tm-accent)]"
              />
              {VIEW_TYPE_LABEL[t]}
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}
    {#if mode !== 'rename'}
      <fieldset class="flex flex-col gap-1 text-sm">
        <legend class="mb-1 font-medium">Who sees it</legend>
        <label class="flex items-center gap-2">
          <input
            type="radio"
            name="view-scope"
            value="personal"
            bind:group={scope}
            class="accent-[var(--tm-accent)]"
          />
          Only me <span class="text-xs text-muted">(personal)</span>
        </label>
        <label class="flex items-center gap-2 {canShared ? '' : 'opacity-50'}">
          <input
            type="radio"
            name="view-scope"
            value="shared"
            bind:group={scope}
            disabled={!canShared}
            class="accent-[var(--tm-accent)]"
          />
          Everyone on the board
          <span class="text-xs text-muted">{canShared ? '(shared)' : '(editors only)'}</span>
        </label>
      </fieldset>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button
      variant="primary"
      type="submit"
      form="view-dialog"
      loading={busy}
      disabled={!name.trim()}
    >
      {mode === 'rename' ? 'Rename' : mode === 'new' ? 'Create view' : 'Save view'}
    </Button>
  {/snippet}
</Dialog>
