<!--
  The host page's Dictionary tab: every dictionary granted to this artifact
  (what its BackendDriver.dictionary reaches) that the VIEWER reaches too
  (dictionaryList({ artifactId })), its entries shown with the entries editor.
  ?dictionary= picks one (the first when absent).

  What you may do there is the smaller of the two: the artifact's grant is the
  ceiling, your own reach in the dictionary the floor (dictionaryArtifactReach)
  — so it is read-only unless the artifact was granted write AND you may write.
-->
<script lang="ts">
  // goto() targets are built from this page's own URL (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { BookA, Lock, TriangleAlert } from 'lucide-svelte';
  import {
    artifactCan,
    DICTIONARY_DEFAULT_INDICATOR,
    dictionaryArtifactReach,
    type DictionaryOut,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import EntriesEditor from '$lib/dictionary/EntriesEditor.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { withParams, type ArtifactTabProps } from './index';

  let { artifactId, role }: ArtifactTabProps = $props();

  let dictionaries = $state.raw<DictionaryOut[] | null>(null);
  let failed = $state(false);
  $effect(() => {
    const id = artifactId;
    dictionaries = null;
    failed = false;
    command('dictionaryList', { artifactId: id }, { toast: false }).then(
      (r) => id === artifactId && (dictionaries = r.dictionaries),
      () => id === artifactId && (failed = true),
    );
  });

  const wanted = $derived(page.url.searchParams.get('dictionary'));
  const current = $derived(dictionaries?.find((d) => d.id === wanted) ?? dictionaries?.[0] ?? null);
  const options = $derived(
    (dictionaries ?? []).map((d) => ({
      value: d.id,
      label: d.name,
      indicator: { of: d, seed: d.id, fallback: DICTIONARY_DEFAULT_INDICATOR },
    })),
  );
  const access = $derived(
    current && current.grant
      ? dictionaryArtifactReach(
          { artifacts: { [artifactId]: current.grant } },
          artifactId,
          current.reach,
        )
      : null,
  );
  const writable = $derived(access === 'write' && !current?.archived);

  function pick(id: string | null) {
    if (!id || id === current?.id) return;
    void goto(withParams(page.url, { dictionary: id }), { keepFocus: true, noScroll: true });
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-artifact-tab="dictionary" data-artifact={artifactId}>
  {#if failed}
    <EmptyState
      icon={TriangleAlert}
      title="Couldn't load the dictionaries"
      description="Something went wrong. Check your connection and try again."
    />
  {:else if !dictionaries}
    <div class="flex flex-col gap-3 p-6"><Skeleton lines={4} /></div>
  {:else if !current}
    <EmptyState
      icon={BookA}
      title="No dictionaries to show"
      description={artifactCan.manage(role)
        ? 'This artifact has not been given a dictionary yet. Add one in its settings › Dictionaries; its page then reaches it through BackendDriver.dictionary.'
        : 'This artifact uses no dictionary you can open.'}
    >
      {#snippet action()}
        {#if artifactCan.manage(role)}
          <Button href={routes.artifactSettings(artifactId, 'dictionaries')}>Dictionaries</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <div
      class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
    >
      {#if dictionaries.length > 1}
        <span class="text-xs text-muted">Dictionary</span>
        <Select
          {options}
          value={current.id}
          aria-label="Dictionary"
          class="w-64 max-w-full"
          onchange={(e) => pick(e.currentTarget.value)}
        />
      {:else}
        <span class="text-sm font-medium">{current.name}</span>
      {/if}
      <span class="text-xs text-subtle"
        >The page {current.grant === 'write' ? 'reads and writes' : 'reads'} it</span
      >
      {#if !writable}
        <span class="flex items-center gap-1 text-xs text-subtle" data-read-only
          ><Lock size={12} aria-hidden="true" /> Read only</span
        >
      {/if}
      <span class="flex-1"></span>
      <Button size="sm" variant="ghost" href={routes.dictionary(current.id)}>Open</Button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {#key current.id}
        <EntriesEditor dictionaryId={current.id} {writable} />
      {/key}
    </div>
  {/if}
</div>
