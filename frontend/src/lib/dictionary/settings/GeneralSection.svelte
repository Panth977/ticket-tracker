<!--
  Dictionary settings › General (owner only): name, description, indicator —
  one dictionaryUpdate with the keys that changed — then move to another
  owner, archive / restore and delete. Deleting removes every entry for good,
  so it asks for the name.
-->
<script lang="ts">
  import MoveOwner from '$lib/orgs/MoveOwner.svelte';
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    DICTIONARY_DESCRIPTION_MAX,
    DICTIONARY_NAME_MAX,
    formatBytes,
    DICTIONARY_DEFAULT_INDICATOR,
    indicatorOf,
    type Indicator,
  } from '@tm/shared';
  import IndicatorField from '$lib/ui/IndicatorField.svelte';
  import { command, type CommandInput } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import { useDraft } from '$lib/board/settings/draft.svelte';
  import { routes } from '$lib/layout/routes';
  import { Button, Dialog, Input, Textarea, toast } from '$lib/ui';
  import { useDictionarySettings } from './context.svelte';

  const s = useDictionarySettings();
  const m = $derived(s.dictionary);
  const archived = $derived(m.archivedAt != null);

  type G = { name: string; description: string; indicator: Indicator };
  const draft = useDraft<G>(() => ({
    name: s.dictionary.name,
    description: s.dictionary.description ?? '',
    indicator: indicatorOf(s.dictionary, s.dictionary.id, DICTIONARY_DEFAULT_INDICATOR),
  }));
  const d = $derived(draft.value);

  let saving = $state(false);
  async function save() {
    const base = untrack(() => draft.base);
    const v = draft.value;
    if (!v.name.trim()) return;
    const patch: Omit<CommandInput<'dictionaryUpdate'>, 'dictionaryId'> = {};
    if (v.name.trim() !== base.name) patch.name = v.name.trim();
    if (v.description.trim() !== base.description) patch.description = v.description.trim() || null;
    if (JSON.stringify(v.indicator) !== JSON.stringify(base.indicator))
      patch.indicator = v.indicator;
    if (!Object.keys(patch).length) return draft.reset();
    saving = true;
    try {
      await command(
        'dictionaryUpdate',
        { dictionaryId: m.id, ...patch },
        { toast: 'Could not save' },
      );
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
        'dictionaryUpdate',
        { dictionaryId: m.id, archived: !restoring },
        { toast: restoring ? 'Could not restore' : 'Could not archive' },
      );
      toast.success(restoring ? 'Dictionary restored' : 'Dictionary archived');
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
      await command(
        'dictionaryDelete',
        { dictionaryId: m.id },
        { toast: 'Could not delete the dictionary' },
      );
      deleteOpen = false;
      toast.success(`${name} was deleted`);
      void goto(routes.dictionaries(), { replaceState: true });
    } catch {
      /* toasted */
    } finally {
      busy = '';
    }
  }
</script>

<Section
  title="General"
  description="What this dictionary is called."
  dirty={draft.dirty}
  busy={saving}
  onsave={save}
  onreset={draft.reset}
>
  <div class="grid max-w-xl gap-5">
    <Input
      label="Name"
      value={d.name}
      maxlength={DICTIONARY_NAME_MAX}
      required
      oninput={(e) => (draft.value = { ...d, name: e.currentTarget.value })}
    />
    <Textarea
      label="Description"
      value={d.description}
      maxlength={DICTIONARY_DESCRIPTION_MAX}
      rows={2}
      hint="What its entries are for — agents read it."
      oninput={(e) => (draft.value = { ...d, description: e.currentTarget.value })}
    />
    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium">Indicator</span>
      <IndicatorField
        value={d.indicator}
        seed={m.id}
        label="Dictionary indicator"
        onchange={(i) => (draft.value = { ...d, indicator: i })}
      />
    </div>
    <p class="text-sm text-muted">
      {m.stats.entries}
      {m.stats.entries === 1 ? 'entry' : 'entries'} · {formatBytes(m.stats.bytes)}
    </p>
  </div>
</Section>

<section class="mt-10 flex flex-col gap-3" aria-labelledby="dictionary-danger">
  <h3 id="dictionary-danger" class="text-sm font-semibold text-muted">Danger zone</h3>
  <div
    class="flex max-w-2xl flex-col divide-y divide-line rounded-xl border border-danger/40 bg-surface"
  >
    {#if s.isOwner}<MoveOwner
        kind="dictionary"
        id={s.dictionary.id}
        ownerKey={s.dictionary.ownerKey}
      />{/if}
    <div class="flex flex-wrap items-center gap-3 p-5">
      <div class="min-w-0 flex-1">
        <h3 class="font-medium">
          {archived ? 'Restore this dictionary' : 'Archive this dictionary'}
        </h3>
        <p class="text-sm text-muted">
          {archived
            ? 'Its entries can be changed again and it goes back in everyone’s sidebar.'
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
        <h3 class="font-medium">Delete this dictionary</h3>
        <p class="text-sm text-muted">
          Every entry is deleted for good, for everyone it is shared with. Boards, artifacts and
          agents that use it stop seeing it at once.
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
  description="This can't be undone. Type the dictionary's name to confirm."
>
  <form id="delete-dictionary" onsubmit={(e) => (e.preventDefault(), del())}>
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
      form="delete-dictionary"
      disabled={!confirmed}
      loading={busy === 'delete'}>Delete forever</Button
    >
  {/snippet}
</Dialog>
