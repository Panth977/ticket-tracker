<!--
  Where a bucket's files live, and moving them (bucket.html §K6): managed ⇄ a
  folder in my Google Drive. The bucket's own Storage tab shows it, and the
  Storage tabs of the boards and artifacts that use the bucket show it too.
  Only the bucket's owner moves it; everyone else sees where it lives.
  Progress comes live from bucket.move (the queued job writes it).
-->
<script lang="ts">
  import { FolderOpen, HardDrive, TriangleAlert } from 'lucide-svelte';
  import { command } from '$lib/api';
  import { bucketDoc } from '$lib/bucket/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Button, Dialog, toast } from '$lib/ui';
  import StorageField, { storageInput, type StorageChoice } from './StorageField.svelte';
  import { driveState } from './drive.svelte';

  let { bucketId, name = '' }: { bucketId: string; name?: string } = $props();

  const q = $derived(bucketDoc(bucketId));
  const b = $derived($q.data);
  const current = $derived<'managed' | 'drive'>(b?.storage?.kind === 'drive' ? 'drive' : 'managed');
  const isOwner = $derived(!!b && !!auth.uid && b.access?.[auth.uid] === 'owner');
  const move = $derived(b?.move ?? null);
  const running = $derived(move?.state === 'running');
  const pct = $derived(move && move.total ? Math.round((move.done / move.total) * 100) : 0);

  let choice = $state<StorageChoice>({ kind: 'drive', folderPath: '' });
  let picked = false;
  $effect(() => {
    if (!b || picked) return;
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
        'bucketStorageMove',
        { bucketId, to },
        { toast: 'Could not start the move' },
      );
      confirmOpen = false;
      toast.success(`Moving ${r.total} ${r.total === 1 ? 'item' : 'items'}`);
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
      await command('bucketStorageMove', { bucketId, resume: true }, { toast: 'Could not resume' });
      toast.success('Move resumed');
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
  const label = (k: 'managed' | 'drive' | 'none') =>
    k === 'drive' ? 'Google Drive' : 'managed storage';
</script>

<div class="flex flex-col gap-4" data-testid="storage-move" data-bucket={bucketId}>
  <div class="flex items-start gap-3 rounded-lg border border-line bg-surface p-4">
    {#if current === 'drive'}
      <FolderOpen size={18} class="mt-0.5 text-muted" aria-hidden="true" />
      <div class="text-sm">
        <p class="font-medium">
          {name || b?.name || 'This bucket'} lives in Google Drive
        </p>
        <p class="text-muted">
          Folder <span class="text-text">{b?.storage?.folderName}</span>{b?.storage?.email
            ? ` in ${b.storage.email}`
            : ''}. Drive is the source of truth.
        </p>
      </div>
    {:else}
      <HardDrive size={18} class="mt-0.5 text-muted" aria-hidden="true" />
      <div class="text-sm">
        <p class="font-medium">{name || b?.name || 'This bucket'} is managed</p>
        <p class="text-muted">Its files are kept by this app.</p>
      </div>
    {/if}
  </div>

  {#if running && move}
    <div
      class="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft p-4"
      data-testid="storage-move-progress"
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
      <p class="text-xs text-muted">
        The bucket is read-only until it finishes. You can leave this page.
      </p>
      {#if move.error}<p class="text-xs text-warning">{move.error}</p>{/if}
    </div>
  {:else if b && !isOwner}
    <p class="text-sm text-muted">Only the bucket's owner can move its files.</p>
  {:else if b}
    {#if move?.state === 'failed'}
      <div class="flex flex-col gap-2 rounded-lg border border-danger/40 p-4" role="alert">
        <p class="flex items-start gap-2 text-sm text-danger">
          <TriangleAlert size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
          The move to {label(move.to)} stopped at {move.done} of {move.total}: {move.error ??
            'unknown error'}. Nothing was lost — the bucket still reads from where it was.
        </p>
        <div>
          <Button
            variant="primary"
            loading={busy}
            onclick={resume}
            data-testid="storage-move-resume">Resume the move</Button
          >
        </div>
        <p class="text-xs text-muted">
          Resuming keeps what was already copied{move.target
            ? ` to “${move.target.folderName}”`
            : ''}. Or pick a new destination below.
        </p>
      </div>
    {/if}
    <StorageField
      bind:value={choice}
      name={name || b.name}
      label="Move its files to"
      managedHint="Kept by this app"
    />
    {#if choice.kind === current}
      <p class="text-xs text-muted">That is where it is now — pick the other one to move.</p>
    {/if}
    <div>
      <Button
        variant="primary"
        disabled={!ready}
        onclick={() => (confirmOpen = true)}
        data-testid="storage-move-start">Move files to {label(choice.kind)}</Button
      >
    </div>
  {/if}
</div>

<Dialog bind:open={confirmOpen} title="Move to {label(choice.kind)}?" size="sm">
  <p class="text-sm">
    Every file and folder is copied, then the bucket switches over. It stays readable meanwhile but
    nobody can change it until the move ends. Ticket links keep working.
  </p>
  <p class="mt-2 text-sm text-muted">
    {choice.kind === 'drive'
      ? 'Afterwards the copy kept by this app is deleted.'
      : 'Afterwards the Drive folder is left as it is — nothing in your Drive is deleted.'}
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmOpen = false)}>Cancel</Button>
    <Button variant="primary" loading={busy} onclick={start} data-testid="storage-move-confirm"
      >Move</Button
    >
  {/snippet}
</Dialog>
