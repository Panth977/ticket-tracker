<!--
  ONE DICTIONARY (docs/plan/dictionary.html): its header — the same title
  dropdown as a board's or a bucket's, the org crumb, Read only / Archived,
  Share and Settings — then its entries (EntriesEditor).

  Its own people read it live (the rules allow them the document and its
  content). Someone who reaches it only through a board grant cannot read the
  document directly: they get it from dictionaryGet, and the editor reads the
  entries the same way.
-->
<script lang="ts">
  import { APP_NAME } from '$lib/brand';
  import { Lock, SearchX, Settings, Share2 } from 'lucide-svelte';
  import {
    DICTIONARY_DEFAULT_INDICATOR,
    formatBytes,
    type DictionaryOut,
    type DictionaryReach,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import OrgCrumb from '$lib/orgs/OrgCrumb.svelte';
  import { switcherFor } from '$lib/orgs/switcherStore';
  import TitleSwitcher from '$lib/orgs/TitleSwitcher.svelte';
  import { Button, EmptyState, IconButton, Skeleton } from '$lib/ui';
  import EntriesEditor from './EntriesEditor.svelte';
  import {
    canManageDictionary,
    canWriteDictionary,
    dictionaryDoc,
    dictionaryRoleIn,
    myDictionaryReach,
  } from './store';

  let { dictionaryId }: { dictionaryId: string } = $props();

  const uid = $derived(auth.uid);
  const docQ = $derived(dictionaryDoc(dictionaryId));
  const doc = $derived($docQ.data);
  const role = $derived(dictionaryRoleIn(doc, uid));

  // Not one of its people: ask the API (a board grant may still reach it).
  let viaApi = $state.raw<DictionaryOut | null>(null);
  let missing = $state(false);
  const refused = $derived(!!$docQ.error || (!$docQ.loading && !doc));
  $effect(() => {
    if (!refused) return;
    const id = dictionaryId;
    viaApi = null;
    missing = false;
    command('dictionaryGet', { dictionaryId: id }, { toast: false }).then(
      (r) => id === dictionaryId && (viaApi = r.dictionary),
      () => id === dictionaryId && (missing = true),
    );
  });

  const view = $derived(
    doc
      ? {
          name: doc.name,
          description: doc.description,
          of: doc,
          archived: doc.archivedAt != null,
          stats: doc.stats,
        }
      : viaApi
        ? {
            name: viaApi.name,
            description: viaApi.description,
            of: viaApi,
            archived: viaApi.archived,
            stats: viaApi.stats,
          }
        : null,
  );
  const reach = $derived<DictionaryReach>(
    doc ? myDictionaryReach(doc, uid) : (viaApi?.reach ?? null),
  );
  const writable = $derived(canWriteDictionary(reach) && !view?.archived);
  const switchQ = $derived(switcherFor(uid, { dictionaryId }));
</script>

<svelte:head><title>{view?.name ?? 'Dictionary'} · {APP_NAME}</title></svelte:head>

{#if missing}
  <EmptyState
    icon={SearchX}
    title="Dictionary not found"
    description="It may have been deleted, or it isn't shared with you."
  >
    {#snippet action()}<Button href={routes.home()}>Your space</Button>{/snippet}
  </EmptyState>
{:else if !view}
  <div class="flex flex-col gap-3 p-6">
    <Skeleton height="1.5rem" width="16rem" /><Skeleton lines={5} />
  </div>
{:else}
  <div class="flex min-h-0 flex-col bg-bg" data-dictionary-page={dictionaryId}>
    <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
      {#if $switchQ.org}<OrgCrumb org={$switchQ.org} />{/if}
      <TitleSwitcher
        kind="dictionary"
        items={$switchQ.items}
        name={view.name}
        mark={{ of: view.of, seed: dictionaryId, fallback: DICTIONARY_DEFAULT_INDICATOR }}
      />
      {#if view.archived}
        <span class="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning"
          >Archived</span
        >
      {:else if !writable}
        <span class="flex shrink-0 items-center gap-1 text-xs text-subtle" data-read-only
          ><Lock size={12} aria-hidden="true" /> Read only</span
        >
      {/if}
      <span class="hidden shrink-0 text-xs text-subtle md:inline"
        >{view.stats.entries}
        {view.stats.entries === 1 ? 'entry' : 'entries'} · {formatBytes(view.stats.bytes)}</span
      >
      <span class="flex-1"></span>
      {#if canManageDictionary(reach) && role}
        <IconButton
          icon={Share2}
          label="Share"
          href={routes.dictionarySettings(dictionaryId, 'people')}
        />
      {/if}
      {#if role}
        <IconButton
          icon={Settings}
          label="Dictionary settings"
          href={routes.dictionarySettings(
            dictionaryId,
            role === 'owner' ? 'general' : 'subscribers',
          )}
        />
      {/if}
    </header>
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-8">
      {#if view.description}
        <p class="text-sm whitespace-pre-line text-muted">{view.description}</p>
      {/if}
      {#if view.archived}
        <p role="status" class="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          This dictionary is archived — its entries are read-only until it is restored{role ===
          'owner'
            ? ' (Settings › General)'
            : ''}.
        </p>
      {/if}
      {#key dictionaryId}
        <EntriesEditor {dictionaryId} {writable} live={!!doc} />
      {/key}
    </div>
  </div>
{/if}
