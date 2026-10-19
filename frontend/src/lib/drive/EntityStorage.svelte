<!--
  Where a board, a dictionary or an artifact lives, and moving it (bucket.html
  §L4): this app's database ⇄ a folder in my Google Drive. A board keeps its
  settings, views, templates, webhooks and tickets there (one file per ticket
  and message); a dictionary its entries (sealed); an artifact its data. Who
  manages it moves it; everyone else sees where it is. Progress comes live
  from <kind>.move (the queued job writes it).
-->
<script lang="ts">
  import { FolderOpen, HardDrive, TriangleAlert } from 'lucide-svelte';
  import type { BoardDriveStorage, BoardMove } from '@tm/shared';
  import { command } from '$lib/api';
  import { forgetBoardKind } from '$lib/firebase/routedFirestore';
  import { docStore } from '$lib/stores/live';
  import { Button, Dialog, toast } from '$lib/ui';
  import StorageField, { storageInput, type StorageChoice } from './StorageField.svelte';
  import { driveState } from './drive.svelte';

  type Kind = 'boards' | 'dictionaries' | 'artifacts';
  let { kind, id, canMove = false }: { kind: Kind; id: string; canMove?: boolean } = $props();

  const NOUN: Record<Kind, string> = {
    boards: 'board',
    dictionaries: 'dictionary',
    artifacts: 'artifact',
  };
  const WHAT: Record<Kind, string> = {
    boards: 'its settings, views, templates, webhooks, tickets and messages',
    dictionaries: 'its entries (sealed with your recovery key)',
    artifacts: 'its settings and data',
  };
  const WHO: Record<Kind, string> = {
    boards: 'Only a board admin can move it.',
    dictionaries: "Only the dictionary's owner can move it.",
    artifacts: "Only the artifact's owner can move it.",
  };

  type Doc = { name?: string; storage?: BoardDriveStorage | null; move?: BoardMove | null };
  const q = $derived(docStore<Doc>(`${kind}/${id}`));
  const d = $derived($q.data);
  const current = $derived<'managed' | 'drive'>(d?.storage?.kind === 'drive' ? 'drive' : 'managed');
  const move = $derived(d?.move ?? null);
  const running = $derived(move?.state === 'running');
  const pct = $derived(move && move.total ? Math.round((move.done / move.total) * 100) : 0);

  // A finished move changes where it is read from: ask again.
  $effect(() => {
    void current;
    forgetBoardKind(`${kind}/${id}`);
  });

  let choice = $state<StorageChoice>({ kind: 'drive', folderPath: '' });
  let picked = false;
  $effect(() => {
    if (!d || picked) return;
    picked = true;
    choice = current === 'drive' ? { kind: 'managed' } : { kind: 'drive', folderPath: '' };
  });
  const ready = $derived(
    choice.kind !== current && (choice.kind !== 'drive' || !!driveState.status?.connected),
  );

  let confirmOpen = $state(false);
  let busy = $state(false);
  async function start() {
    const to = storageInput(choice);
    if (!to || busy) return;
    busy = true;
    try {
      const r = await command(
        'entityStorageMove',
        { kind, id, to },
        { toast: 'Could not start the move' },
      );
      confirmOpen = false;
      toast.success(`Moving — ${r.total} ${r.total === 1 ? 'step' : 'steps'}`);
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
  async function resume() {
    if (busy) return;
    busy = true;
    try {
      await command('entityStorageMove', { kind, id, resume: true }, { toast: 'Could not resume' });
      toast.success('Move resumed');
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
  const label = (k: 'managed' | 'drive' | 'none') => (k === 'drive' ? 'Google Drive' : 'this app');
</script>

<div class="flex flex-col gap-4" data-testid="entity-storage" data-kind={kind} data-id={id}>
  <div class="flex items-start gap-3 rounded-lg border border-line bg-surface p-4">
    {#if current === 'drive'}
      <FolderOpen size={18} class="mt-0.5 text-muted" aria-hidden="true" />
      <div class="text-sm">
        <p class="font-medium">This {NOUN[kind]} lives in Google Drive</p>
        <p class="text-muted">
          Folder <span class="text-text">{d?.storage?.folderName}</span>{d?.storage?.email
            ? ` in ${d.storage.email}`
            : ''}: {WHAT[kind]}. Drive is the source of truth; this app keeps only who may see it
          and where it is.
        </p>
      </div>
    {:else}
      <HardDrive size={18} class="mt-0.5 text-muted" aria-hidden="true" />
      <div class="text-sm">
        <p class="font-medium">This {NOUN[kind]} is kept by this app</p>
        <p class="text-muted">
          Move it to a folder of your Google Drive to keep {WHAT[kind]} there.
        </p>
      </div>
    {/if}
  </div>

  {#if running && move}
    <div
      class="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft p-4"
      data-testid="entity-storage-progress"
    >
      <p class="text-sm font-medium">
        Moving to {label(move.to)} — {move.done} of {move.total}
      </p>
      <div
        class="h-2 overflow-hidden rounded bg-surface-2"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div class="h-full bg-accent transition-all" style="width:{pct}%"></div>
      </div>
      <p class="text-xs text-muted">It is read-only until it finishes. You can leave this page.</p>
      {#if move.error}<p class="text-xs text-warning">{move.error}</p>{/if}
    </div>
  {:else if d && !canMove}
    <p class="text-sm text-muted">{WHO[kind]}</p>
  {:else if d}
    {#if move?.state === 'failed'}
      <div class="flex flex-col gap-2 rounded-lg border border-danger/40 p-4" role="alert">
        <p class="flex items-start gap-2 text-sm text-danger">
          <TriangleAlert size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
          The move to {label(move.to)} stopped at {move.done} of {move.total}: {move.error ??
            'unknown error'}. Nothing was lost — it still reads from where it was.
        </p>
        <div>
          <Button
            variant="primary"
            loading={busy}
            onclick={resume}
            data-testid="entity-storage-resume">Resume the move</Button
          >
        </div>
      </div>
    {/if}
    <StorageField
      bind:value={choice}
      name={d.name ?? ''}
      label="Move it to"
      managedHint="This app's database"
      driveHint="A folder in your Drive — Drive becomes the source of truth"
    />
    {#if choice.kind === current}
      <p class="text-xs text-muted">That is where it is now — pick the other one to move.</p>
    {/if}
    <div>
      <Button
        variant="primary"
        disabled={!ready}
        onclick={() => (confirmOpen = true)}
        data-testid="entity-storage-start">Move to {label(choice.kind)}</Button
      >
    </div>
  {/if}
</div>

<Dialog bind:open={confirmOpen} title="Move to {label(choice.kind)}?" size="sm">
  <p class="text-sm">
    Everything it keeps is copied, then it switches over. It stays readable meanwhile, but nothing
    in it can change until the move ends.
  </p>
  <p class="mt-2 text-sm text-muted">
    {choice.kind === 'drive'
      ? 'Afterwards the copy in this app is deleted.' +
        (kind === 'dictionaries'
          ? ''
          : ' Buckets it uses stay where they are; each moves from its own Storage tab.')
      : 'Afterwards the Drive folder is left as it is — nothing in your Drive is deleted.'}
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmOpen = false)}>Cancel</Button>
    <Button variant="primary" loading={busy} onclick={start} data-testid="entity-storage-confirm"
      >Move</Button
    >
  {/snippet}
</Dialog>
