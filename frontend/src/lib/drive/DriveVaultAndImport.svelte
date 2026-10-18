<!--
  Account › Google Drive, once connected (bucket.html §L6, §L7):

  · the RECOVERY CODE — the only key, besides this server, to the secrets kept
    in my Drive (a dictionary's entries, a board's webhooks and integrations).
    Shown once; needed to import those folders into another TaskManager.
  · IMPORT — a folder a TaskManager kept a board, dictionary, bucket or
    artifact in (it has .tm-entity.json) becomes one here again.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { Copy, FolderInput, KeyRound } from 'lucide-svelte';
  import { command } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import { Button, Dialog, Input, toast } from '$lib/ui';
  import { pickDriveFolder } from './drive.svelte';

  let vault = $state<{ has: boolean; pending: boolean } | null>(null);
  let code = $state<string | null>(null);
  let busy = $state(false);

  onMount(async () => {
    try {
      vault = await command('driveRecoveryCode', {}, { toast: false });
    } catch {
      vault = null;
    }
  });

  async function reveal() {
    busy = true;
    try {
      const r = await command('driveRecoveryCode', { take: true }, { toast: 'Could not show it' });
      vault = { has: r.has, pending: r.pending };
      code = r.code;
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
  async function copy() {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    toast.success('Copied — keep it somewhere safe');
  }

  // ── import ──
  let importOpen = $state(false);
  let folder = $state<{ id: string; name: string } | null>(null);
  let recoveryCode = $state('');
  let needsCode = $state(false);
  let importing = $state(false);

  async function pick() {
    const f = await pickDriveFolder('Choose a TaskManager folder to import');
    if (!f) return;
    folder = f;
    needsCode = false;
    recoveryCode = '';
    importOpen = true;
  }
  async function runImport() {
    if (!folder || importing) return;
    importing = true;
    try {
      const r = await command(
        'driveImport',
        {
          folderId: folder.id,
          ...(recoveryCode.trim() ? { recoveryCode: recoveryCode.trim() } : {}),
        },
        { toast: false },
      );
      importOpen = false;
      const others = r.people.length;
      toast.success(
        `Imported “${r.name}”` +
          (others
            ? ` — invite its ${others} other ${others === 1 ? 'person' : 'people'} from its settings`
            : ''),
      );
      await goto(
        r.kind === 'boards' && r.key
          ? routes.board(r.key)
          : r.kind === 'dictionaries'
            ? routes.dictionary(r.id)
            : r.kind === 'buckets'
              ? routes.bucket(r.id)
              : routes.artifact(r.id),
      );
    } catch (e) {
      const err = e as { details?: { reason?: string }; message?: string };
      if (err.details?.reason === 'drive_locked') needsCode = true;
      else toast.error('Could not import that folder', err.message);
    } finally {
      importing = false;
    }
  }
</script>

<div
  class="mt-6 flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
  data-testid="drive-vault"
>
  <p class="flex items-center gap-2 font-medium">
    <KeyRound size={16} aria-hidden="true" /> Recovery code
  </p>
  {#if code}
    <p class="text-sm">
      This is the only time it is shown. Keep it somewhere safe — with it, another TaskManager can
      open the secrets you keep in Google Drive.
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <code
        class="rounded bg-surface-2 px-2 py-1 font-mono text-sm"
        data-testid="drive-recovery-code">{code}</code
      >
      <Button size="sm" variant="ghost" icon={Copy} onclick={copy}>Copy</Button>
    </div>
  {:else if vault?.pending}
    <p class="text-sm">Your recovery code is ready. It is shown once.</p>
    <div>
      <Button variant="primary" loading={busy} onclick={reveal} data-testid="drive-recovery-reveal"
        >Show my recovery code</Button
      >
    </div>
  {:else if vault?.has}
    <p class="text-sm text-muted">
      You have seen your recovery code. Without it, secrets kept in your Drive open only on this
      TaskManager.
    </p>
  {:else}
    <p class="text-sm text-muted">
      Secrets you keep in Google Drive (a dictionary's entries, a board's webhooks) are sealed with
      a key only you and this server hold.
    </p>
    <div><Button size="sm" loading={busy} onclick={reveal}>Make my recovery code</Button></div>
  {/if}
</div>

<div
  class="mt-4 flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
  data-testid="drive-import"
>
  <p class="flex items-center gap-2 font-medium">
    <FolderInput size={16} aria-hidden="true" /> Import from Google Drive
  </p>
  <p class="text-sm text-muted">
    A folder where a TaskManager — this one or another — kept a board, dictionary, bucket or
    artifact becomes one here again. Nothing is copied: the folder stays the source of truth.
  </p>
  <div>
    <Button icon={FolderInput} onclick={pick} data-testid="drive-import-pick"
      >Choose a folder…</Button
    >
  </div>
</div>

<Dialog bind:open={importOpen} title="Import “{folder?.name ?? ''}”?" size="sm">
  <p class="text-sm">
    You become its owner here. Its other people are listed so you can invite them.
  </p>
  {#if needsCode}
    <p class="mt-3 text-sm text-warning">
      Its secrets were sealed by another TaskManager. Enter the recovery code of the person who kept
      it.
    </p>
    <div class="mt-2">
      <Input
        label="Recovery code"
        bind:value={recoveryCode}
        autocomplete="off"
        placeholder="XXXX-XXXX-…"
      />
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (importOpen = false)}>Cancel</Button>
    <Button
      variant="primary"
      loading={importing}
      onclick={runImport}
      data-testid="drive-import-confirm">Import</Button
    >
  {/snippet}
</Dialog>
