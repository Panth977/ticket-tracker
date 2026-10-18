<!--
  Where a board's TICKETS live, and moving them (bucket.html §L4): this app's
  database ⇄ a folder in my Google Drive (tickets/<id>/meta.json, one file per
  message). A board admin moves them; everyone else sees where they are.
  Progress comes live from board.move (the queued job writes it).
-->
<script lang="ts">
  import { FolderOpen, HardDrive, TriangleAlert } from 'lucide-svelte';
  import { paths, type Board } from '@tm/shared';
  import { command } from '$lib/api';
  import { forgetBoardKind } from '$lib/firebase/routedFirestore';
  import { docStore } from '$lib/stores/live';
  import { Button, Dialog, toast } from '$lib/ui';
  import StorageField, { storageInput, type StorageChoice } from './StorageField.svelte';
  import { driveState } from './drive.svelte';

  let { boardId, isAdmin = false }: { boardId: string; isAdmin?: boolean } = $props();

  const q = $derived(docStore<Board>(paths.board(boardId)));
  const b = $derived($q.data);
  const current = $derived<'managed' | 'drive'>(b?.storage?.kind === 'drive' ? 'drive' : 'managed');
  const move = $derived(b?.move ?? null);
  const running = $derived(move?.state === 'running');
  const pct = $derived(move && move.total ? Math.round((move.done / move.total) * 100) : 0);

  // A finished move changes where the tickets are read from: ask again.
  $effect(() => {
    void current;
    forgetBoardKind(boardId);
  });

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
        'boardStorageMove',
        { boardId, to },
        { toast: 'Could not start the move' },
      );
      confirmOpen = false;
      toast.success(`Moving ${r.total} ${r.total === 1 ? 'ticket' : 'tickets'}`);
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
      await command('boardStorageMove', { boardId, resume: true }, { toast: 'Could not resume' });
      toast.success('Move resumed');
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
  const label = (k: 'managed' | 'drive' | 'none') => (k === 'drive' ? 'Google Drive' : 'this app');
</script>

<div class="flex flex-col gap-4" data-testid="board-storage" data-board={boardId}>
  <div class="flex items-start gap-3 rounded-lg border border-line bg-surface p-4">
    {#if current === 'drive'}
      <FolderOpen size={18} class="mt-0.5 text-muted" aria-hidden="true" />
      <div class="text-sm">
        <p class="font-medium">Its tickets live in Google Drive</p>
        <p class="text-muted">
          Folder <span class="text-text">{b?.storage?.folderName}</span>{b?.storage?.email
            ? ` in ${b.storage.email}`
            : ''}: <span class="font-mono text-xs">tickets/&lt;id&gt;/meta.json</span> and one file per
          message. Drive is the source of truth; this app keeps only where they are.
        </p>
      </div>
    {:else}
      <HardDrive size={18} class="mt-0.5 text-muted" aria-hidden="true" />
      <div class="text-sm">
        <p class="font-medium">Its tickets are kept by this app</p>
        <p class="text-muted">Tickets, messages and task lists live in this app's database.</p>
      </div>
    {/if}
  </div>

  {#if running && move}
    <div
      class="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft p-4"
      data-testid="board-storage-progress"
    >
      <p class="text-sm font-medium">
        Moving tickets to {label(move.to)} — {move.done} of {move.total}
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
        Tickets are read-only until it finishes. You can leave this page.
      </p>
      {#if move.error}<p class="text-xs text-warning">{move.error}</p>{/if}
    </div>
  {:else if b && !isAdmin}
    <p class="text-sm text-muted">Only a board admin can move its tickets.</p>
  {:else if b}
    {#if move?.state === 'failed'}
      <div class="flex flex-col gap-2 rounded-lg border border-danger/40 p-4" role="alert">
        <p class="flex items-start gap-2 text-sm text-danger">
          <TriangleAlert size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
          The move to {label(move.to)} stopped at {move.done} of {move.total}: {move.error ??
            'unknown error'}. Nothing was lost — the tickets still read from where they were.
        </p>
        <div>
          <Button
            variant="primary"
            loading={busy}
            onclick={resume}
            data-testid="board-storage-resume">Resume the move</Button
          >
        </div>
      </div>
    {/if}
    <StorageField
      bind:value={choice}
      name={b.name}
      label="Move its tickets to"
      managedHint="This app's database"
      driveHint="A folder in your Drive: one file per ticket and message"
    />
    {#if choice.kind === current}
      <p class="text-xs text-muted">That is where they are now — pick the other one to move.</p>
    {/if}
    <div>
      <Button
        variant="primary"
        disabled={!ready}
        onclick={() => (confirmOpen = true)}
        data-testid="board-storage-start">Move tickets to {label(choice.kind)}</Button
      >
    </div>
  {/if}
</div>

<Dialog bind:open={confirmOpen} title="Move tickets to {label(choice.kind)}?" size="sm">
  <p class="text-sm">
    Every ticket, with its messages and task lists, is copied, then the board switches over. It
    stays readable meanwhile, but nobody can change a ticket until the move ends.
  </p>
  <p class="mt-2 text-sm text-muted">
    {choice.kind === 'drive'
      ? 'Afterwards the copy in this app is deleted. Its file bucket moves separately, below.'
      : 'Afterwards the Drive folder is left as it is — nothing in your Drive is deleted.'}
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmOpen = false)}>Cancel</Button>
    <Button variant="primary" loading={busy} onclick={start} data-testid="board-storage-confirm"
      >Move</Button
    >
  {/snippet}
</Dialog>
