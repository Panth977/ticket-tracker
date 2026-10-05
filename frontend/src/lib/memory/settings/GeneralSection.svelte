<!--
  Memory settings › General (owner only): name, emoji, description — one
  memoryUpdate with the keys that changed — then archive / restore and delete.
  Deleting removes every file for good, so it asks for the name.
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { MEMORY_DESCRIPTION_MAX, MEMORY_NAME_MAX, formatBytes } from '@tm/shared';
  import { command, type CommandInput } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import { useDraft } from '$lib/board/settings/draft.svelte';
  import { routes } from '$lib/layout/routes';
  import { Button, Dialog, Input, Textarea, toast } from '$lib/ui';
  import { useMemorySettings } from './context.svelte';

  const s = useMemorySettings();
  const m = $derived(s.memory);
  const archived = $derived(m.archivedAt != null);

  type G = { name: string; description: string; icon: string };
  const draft = useDraft<G>(() => ({
    name: s.memory.name,
    description: s.memory.description ?? '',
    icon: s.memory.icon ?? '',
  }));
  const d = $derived(draft.value);

  let saving = $state(false);
  async function save() {
    const base = untrack(() => draft.base);
    const v = draft.value;
    if (!v.name.trim()) return;
    const patch: Omit<CommandInput<'memoryUpdate'>, 'memoryId'> = {};
    if (v.name.trim() !== base.name) patch.name = v.name.trim();
    if (v.description.trim() !== base.description) patch.description = v.description.trim() || null;
    if (v.icon.trim() !== base.icon) patch.icon = v.icon.trim() || null;
    if (!Object.keys(patch).length) return draft.reset();
    saving = true;
    try {
      await command('memoryUpdate', { memoryId: m.id, ...patch }, { toast: 'Could not save' });
      draft.commit();
      toast.success('Saved');
    } catch {
      /* toasted */
    } finally {
      saving = false;
    }
  }

  let busy = $state<'' | 'archive' | 'delete'>('');
  async function archive() {
    const restoring = archived;
    busy = 'archive';
    try {
      await command(
        'memoryUpdate',
        { memoryId: m.id, archived: !restoring },
        { toast: restoring ? 'Could not restore' : 'Could not archive' },
      );
      toast.success(restoring ? 'Memory restored' : 'Memory archived');
    } catch {
      /* toasted */
    } finally {
      busy = '';
    }
  }

  let deleteOpen = $state(false);
  let confirmName = $state('');
  const confirmed = $derived(confirmName.trim() === m.name);
  async function del() {
    if (!confirmed) return;
    const name = m.name;
    busy = 'delete';
    try {
      await command('memoryDelete', { memoryId: m.id }, { toast: 'Could not delete the memory' });
      deleteOpen = false;
      toast.success(`${name} is being deleted`);
      void goto(routes.memories(), { replaceState: true });
    } catch {
      /* toasted */
    } finally {
      busy = '';
    }
  }
</script>

<Section
  title="General"
  description="What this memory is called."
  dirty={draft.dirty}
  busy={saving}
  onsave={save}
  onreset={draft.reset}
>
  <div class="grid max-w-xl gap-5">
    <Input
      label="Name"
      value={d.name}
      maxlength={MEMORY_NAME_MAX}
      required
      oninput={(e) => (draft.value = { ...d, name: e.currentTarget.value })}
    />
    <Textarea
      label="Description"
      value={d.description}
      maxlength={MEMORY_DESCRIPTION_MAX}
      rows={2}
      oninput={(e) => (draft.value = { ...d, description: e.currentTarget.value })}
    />
    <Input
      label="Emoji"
      value={d.icon}
      maxlength={16}
      class="max-w-40"
      hint="Shown next to the name. Empty = 🧠."
      oninput={(e) => (draft.value = { ...d, icon: e.currentTarget.value })}
    />
    <p class="text-sm text-muted">
      {m.stats.files}
      {m.stats.files === 1 ? 'file' : 'files'} in {m.stats.folders}
      {m.stats.folders === 1 ? 'folder' : 'folders'} · {formatBytes(m.stats.bytes)}
    </p>
  </div>
</Section>

<section class="mt-10 flex flex-col gap-3" aria-labelledby="memory-danger">
  <h3 id="memory-danger" class="text-sm font-semibold text-muted">Danger zone</h3>
  <div
    class="flex max-w-2xl flex-col divide-y divide-line rounded-xl border border-danger/40 bg-surface"
  >
    <div class="flex flex-wrap items-center gap-3 p-5">
      <div class="min-w-0 flex-1">
        <h3 class="font-medium">{archived ? 'Restore this memory' : 'Archive this memory'}</h3>
        <p class="text-sm text-muted">
          {archived
            ? 'Its files can be changed again and it goes back in everyone’s sidebar.'
            : 'Hidden from the sidebar and read-only for everyone. Nothing is lost.'}
        </p>
      </div>
      <Button
        variant={archived ? 'secondary' : 'danger'}
        loading={busy === 'archive'}
        onclick={() => archive()}>{archived ? 'Restore' : 'Archive'}</Button
      >
    </div>
    <div class="flex flex-wrap items-center gap-3 p-5">
      <div class="min-w-0 flex-1">
        <h3 class="font-medium">Delete this memory</h3>
        <p class="text-sm text-muted">
          Every file and folder is deleted for good, for everyone it is shared with. Tickets that
          point at its files show them as no longer in memory.
        </p>
      </div>
      <Button variant="danger" onclick={() => ((confirmName = ''), (deleteOpen = true))}
        >Delete…</Button
      >
    </div>
  </div>
</section>

<Dialog
  bind:open={deleteOpen}
  title="Delete {m.name}?"
  size="sm"
  description="This can't be undone. Type the memory's name to confirm."
>
  <form id="delete-memory" onsubmit={(e) => (e.preventDefault(), del())}>
    <Input
      label="Name"
      value={confirmName}
      placeholder={m.name}
      autocomplete="off"
      oninput={(e) => (confirmName = e.currentTarget.value)}
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (deleteOpen = false)}>Cancel</Button>
    <Button
      variant="danger"
      type="submit"
      form="delete-memory"
      disabled={!confirmed}
      loading={busy === 'delete'}>Delete forever</Button
    >
  {/snippet}
</Dialog>
