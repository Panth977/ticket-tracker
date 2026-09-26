<!--
  Board settings › Danger zone: archive / restore (admin), delete for good
  (admin, only when the board allows permanent delete, typing the key to
  confirm), and leave the board (anyone — but the last admin can't).
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { command, isAppError } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const b = $derived(s.board);
  const archived = $derived(b.archivedAt != null);
  const admins = $derived(Object.values(b.access).filter((r) => r === 'admin').length);
  const lastAdmin = $derived(s.isAdmin && admins <= 1);

  let busy = $state<'' | 'archive' | 'delete' | 'leave'>('');
  let deleteOpen = $state(false);
  let leaveOpen = $state(false);
  let confirmKey = $state('');

  async function archive() {
    // Read once: the live board flips archivedAt before the toast shows.
    const restoring = archived;
    busy = 'archive';
    try {
      await command(
        'boardArchive',
        { boardId: b.id, action: restoring ? 'restore' : 'archive' },
        { toast: restoring ? 'Could not restore' : 'Could not archive' },
      );
      toast.success(
        restoring ? 'Board restored' : 'Board archived',
        restoring ? undefined : 'It is read-only now and hidden from the sidebar.',
      );
    } catch {
      /* toasted */
    } finally {
      busy = '';
    }
  }
  async function del() {
    if (confirmKey !== b.key) return;
    busy = 'delete';
    try {
      await command(
        'boardArchive',
        { boardId: b.id, action: 'delete', confirmKey },
        { toast: 'Could not delete the board' },
      );
      toast.success(`${b.key} is being deleted`);
      deleteOpen = false;
      void goto(routes.home(), { replaceState: true });
    } catch {
      /* toasted */
    } finally {
      busy = '';
    }
  }
  async function leave() {
    busy = 'leave';
    try {
      await command('boardAccessSet', { boardId: b.id, leave: true }, { toast: false });
      toast.success(`You left ${b.name}`);
      leaveOpen = false;
      void goto(routes.home(), { replaceState: true });
    } catch (e) {
      toast.error('Could not leave the board', isAppError(e) ? e.message : undefined);
    } finally {
      busy = '';
    }
  }
</script>

<Section title="Danger zone" description="Changes here affect everyone on the board.">
  <div
    class="flex max-w-2xl flex-col divide-y divide-line rounded-xl border border-danger/40 bg-surface"
  >
    {#if s.isAdmin}
      <div class="flex flex-wrap items-center gap-3 p-5">
        <div class="min-w-0 flex-1">
          <h3 class="font-medium">{archived ? 'Restore this board' : 'Archive this board'}</h3>
          <p class="text-sm text-muted">
            {archived
              ? 'Makes it editable again and puts it back in everyone’s sidebar.'
              : 'Read-only for everyone and hidden from the sidebar. Nothing is lost; you can restore it.'}
          </p>
        </div>
        <Button
          variant={archived ? 'secondary' : 'danger'}
          loading={busy === 'archive'}
          onclick={archive}>{archived ? 'Restore' : 'Archive'}</Button
        >
      </div>
      <div class="flex flex-wrap items-center gap-3 p-5">
        <div class="min-w-0 flex-1">
          <h3 class="font-medium">Delete this board</h3>
          <p class="text-sm text-muted">
            {#if b.settings.allowDelete}
              Every ticket, message and file on it is deleted for good. Links to {b.key}-… will say
              “deleted”.
            {:else}
              Turned off — enable “Allow permanent delete” in General first. Archiving is usually
              enough.
            {/if}
          </p>
        </div>
        <Button
          variant="danger"
          disabled={!b.settings.allowDelete}
          onclick={() => ((confirmKey = ''), (deleteOpen = true))}>Delete…</Button
        >
      </div>
    {/if}
    <div class="flex flex-wrap items-center gap-3 p-5">
      <div class="min-w-0 flex-1">
        <h3 class="font-medium">Leave this board</h3>
        <p class="text-sm text-muted">
          {#if lastAdmin}
            You're the only admin — make someone else an admin in People &amp; roles before you
            leave.
          {:else}
            You lose access at once. Someone will have to invite you again to come back.
          {/if}
        </p>
      </div>
      <Button variant="danger" disabled={lastAdmin} onclick={() => (leaveOpen = true)}
        >Leave…</Button
      >
    </div>
  </div>
</Section>

<Dialog
  bind:open={deleteOpen}
  title="Delete {b.name}?"
  size="sm"
  description="This can't be undone. Type the board key to confirm."
>
  <form id="delete-board" onsubmit={(e) => (e.preventDefault(), del())}>
    <Input
      label="Board key"
      value={confirmKey}
      placeholder={b.key}
      autocomplete="off"
      oninput={(e) => (confirmKey = e.currentTarget.value.toUpperCase())}
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (deleteOpen = false)}>Cancel</Button>
    <Button
      variant="danger"
      type="submit"
      form="delete-board"
      disabled={confirmKey !== b.key}
      loading={busy === 'delete'}>Delete forever</Button
    >
  {/snippet}
</Dialog>

<Dialog
  bind:open={leaveOpen}
  title="Leave {b.name}?"
  size="sm"
  description="You'll stop seeing its tickets and notifications right away."
>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (leaveOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={busy === 'leave'} onclick={leave}>Leave board</Button>
  {/snippet}
</Dialog>
