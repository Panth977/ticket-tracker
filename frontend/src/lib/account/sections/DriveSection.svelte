<!--
  Account › Google Drive (bucket.html §K1): connect my Drive so buckets can
  live in it, see which Google account it is, disconnect. The server keeps the
  connection (a refresh token it never hands out); buckets stored in this Drive
  stop opening while it is disconnected — their files stay in Drive.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { FolderOpen } from 'lucide-svelte';
  import { APP_NAME } from '$lib/brand';
  import { Button, Dialog, EmptyState, Skeleton } from '$lib/ui';
  import { connectDrive, disconnectDrive, driveState } from '$lib/drive/drive.svelte';
  import { dateOnly } from '../format';
  import { auth } from '$lib/firebase/auth.svelte';
  import SectionHeader from '../SectionHeader.svelte';
  import DriveVaultAndImport from '$lib/drive/DriveVaultAndImport.svelte';

  onMount(() => void driveState.load(true));
  const st = $derived(driveState.status);
  let confirmOpen = $state(false);
  let busy = $state(false);

  async function connect() {
    busy = true;
    try {
      await connectDrive();
    } catch {
      busy = false;
    }
  }
  async function disconnect() {
    busy = true;
    try {
      await disconnectDrive();
      confirmOpen = false;
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<SectionHeader
  title="Google Drive"
  description="Keep boards, dictionaries, buckets and artifacts in your own Google Drive. {APP_NAME} only sees the files it creates there or the folders you pick."
/>

{#if !st && driveState.loading}
  <Skeleton height="3.5rem" />
{:else if !st?.available}
  <EmptyState
    icon={FolderOpen}
    title="Not set up on this server"
    description="Google Drive needs a Google OAuth client on the server (TM_GOOGLE_CLIENT_ID / TM_GOOGLE_CLIENT_SECRET)."
  />
{:else if !st.connected}
  <div class="flex flex-col items-start gap-3 rounded-xl border border-line bg-surface p-5">
    <p class="text-sm">
      Not connected. Connecting asks Google for access to <em
        >only the files this app creates or you pick</em
      > — never the rest of your Drive.
    </p>
    <Button variant="primary" icon={FolderOpen} loading={busy} onclick={connect}
      >Connect Google Drive</Button
    >
  </div>
{:else}
  <div class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
    <span class="grid size-9 place-items-center rounded-lg bg-surface-2" aria-hidden="true"
      ><FolderOpen size={18} /></span
    >
    <div class="min-w-0 flex-1">
      <p class="font-medium">{st.email ?? 'Google Drive'}</p>
      <p class="text-xs text-muted">
        Connected {st.connectedAt ? dateOnly(st.connectedAt, auth.profile?.timezone) : ''} · new buckets
        can live in this Drive
      </p>
    </div>
    <Button size="sm" variant="ghost" class="text-danger" onclick={() => (confirmOpen = true)}
      >Disconnect</Button
    >
  </div>
  <DriveVaultAndImport />
{/if}

<Dialog bind:open={confirmOpen} title="Disconnect Google Drive?" size="sm">
  <p class="text-sm">
    Buckets stored in this Drive stay — their files are still in Drive — but nobody can open them
    here until you connect again.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={busy} onclick={disconnect}>Disconnect</Button>
  {/snippet}
</Dialog>
