<!--
  "Where do its files live?" (bucket.html §K) — asked when a bucket, a board or
  an artifact is created. Managed (ours) or a folder in MY Google Drive (Drive
  is then the truth: the bucket is that folder). Boards and artifacts may also
  say "none for now" (allowNone).

  Drive needs a connection first (Account › Google Drive); the folder is one
  picked with Google's picker, else a path made in the Drive's top level.
-->
<script lang="ts" module>
  export type StorageChoice =
    | { kind: 'none' }
    | { kind: 'managed' }
    | { kind: 'drive'; folderId?: string; folderName?: string; folderPath?: string };

  /** The bucketCreate `storage` for a choice (null = make no bucket). */
  export function storageInput(
    c: StorageChoice,
  ): { kind: 'managed' } | { kind: 'drive'; folderId?: string; folderPath?: string } | null {
    if (c.kind === 'none') return null;
    if (c.kind === 'managed') return { kind: 'managed' };
    return {
      kind: 'drive',
      ...(c.folderId ? { folderId: c.folderId } : {}),
      ...(!c.folderId && c.folderPath?.trim() ? { folderPath: c.folderPath.trim() } : {}),
    };
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { FolderOpen, HardDrive, Ban } from 'lucide-svelte';
  import { DRIVE_DEFAULT_PARENT } from '@tm/shared';
  import { Button, Input } from '$lib/ui';
  import { connectDrive, driveState, pickDriveFolder } from './drive.svelte';

  let {
    value = $bindable<StorageChoice>({ kind: 'managed' }),
    allowNone = false,
    /** For the default folder's name: 'TaskManager/{name}'. */
    name = '',
    label = 'Storage',
    /** What "managed" means here (a board: "a new bucket for its ticket files"). */
    managedHint = 'Kept by this app',
    noneHint = 'Add one later in settings',
  }: {
    value?: StorageChoice;
    allowNone?: boolean;
    name?: string;
    label?: string;
    managedHint?: string;
    noneHint?: string;
  } = $props();

  onMount(() => void driveState.load());
  const st = $derived(driveState.status);
  const available = $derived(!!st?.available);

  const options = $derived([
    ...(allowNone
      ? [{ id: 'none' as const, label: 'None for now', hint: noneHint, icon: Ban }]
      : []),
    { id: 'managed' as const, label: 'Managed', hint: managedHint, icon: HardDrive },
    {
      id: 'drive' as const,
      label: 'Google Drive',
      hint: available
        ? 'A folder in your Drive is the source of truth'
        : 'Not set up on this server',
      icon: FolderOpen,
    },
  ]);

  function choose(id: StorageChoice['kind']) {
    if (id === 'drive' && !available) return;
    if (id === value.kind) return;
    value = id === 'drive' ? { kind: 'drive', folderPath: '' } : { kind: id };
  }

  let picking = $state(false);
  async function pick() {
    picking = true;
    try {
      const f = await pickDriveFolder();
      if (f) value = { kind: 'drive', folderId: f.id, folderName: f.name };
    } catch {
      /* toasted */
    } finally {
      picking = false;
    }
  }
  const defaultPath = $derived(`${DRIVE_DEFAULT_PARENT}/${name.trim() || 'Bucket'}`);
</script>

<fieldset class="flex flex-col gap-2">
  <legend class="mb-1 text-sm font-medium">{label}</legend>
  <div
    class="grid gap-2 {allowNone ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'}"
    role="radiogroup"
    aria-label={label}
  >
    {#each options as o (o.id)}
      {@const on = value.kind === o.id}
      {@const off = o.id === 'drive' && !available}
      <button
        type="button"
        role="radio"
        aria-checked={on}
        aria-disabled={off}
        data-testid="storage-{o.id}"
        class="flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors {on
          ? 'border-accent bg-accent-soft'
          : 'border-line bg-surface hover:bg-surface-2'} {off
          ? 'cursor-not-allowed opacity-60'
          : ''}"
        onclick={() => choose(o.id)}
      >
        <o.icon size={16} class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <span class="flex flex-col gap-0.5">
          <span class="text-sm font-medium">{o.label}</span>
          <span class="text-xs text-muted">{o.hint}</span>
        </span>
      </button>
    {/each}
  </div>

  {#if value.kind === 'drive'}
    <div class="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/40 p-3">
      {#if !st?.connected}
        <p class="text-sm">Connect your Google Drive first. You come back here after.</p>
        <div>
          <Button size="sm" variant="primary" icon={FolderOpen} onclick={() => connectDrive()}
            >Connect Google Drive</Button
          >
        </div>
      {:else}
        <p class="text-xs text-muted">
          In <span class="font-medium text-text">{st.email ?? 'your'}</span> Drive. People you share it
          with reach it through this app — no Drive sharing needed.
        </p>
        {#if value.folderId}
          <div class="flex items-center gap-2 text-sm">
            <FolderOpen size={14} aria-hidden="true" />
            <span class="flex-1 truncate font-medium">{value.folderName}</span>
            <Button
              size="sm"
              variant="ghost"
              onclick={() => (value = { kind: 'drive', folderPath: '' })}>Change</Button
            >
          </div>
        {:else}
          <Input
            label="Folder"
            placeholder={defaultPath}
            value={value.folderPath ?? ''}
            oninput={(e) =>
              (value = { kind: 'drive', folderPath: (e.currentTarget as HTMLInputElement).value })}
            data-testid="storage-drive-path"
          />
          <p class="text-xs text-muted">
            Made in your Drive’s top level if it is not there.{#if st.picker}
              Or use a folder you already have:{/if}
          </p>
          {#if st.picker}
            <div>
              <Button size="sm" icon={FolderOpen} loading={picking} onclick={pick}
                >Choose a folder in Drive…</Button
              >
            </div>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}
</fieldset>
