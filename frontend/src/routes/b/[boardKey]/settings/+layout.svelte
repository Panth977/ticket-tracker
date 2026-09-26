<!--
  /b/[boardKey]/settings/[section] — Board settings (app.json screens › Board settings):
    [menu: General · Stages · … · Danger zone] | [the section]
  Each section saves itself (boardUpdate with just its key). Non-admins can
  look (read-only) and use the Danger zone to leave.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { ArrowLeft } from 'lucide-svelte';
  import { paths, type BoardMember } from '@tm/shared';
  import { roleOf } from '@tm/shared/logic/can';
  import { auth } from '$lib/firebase/auth.svelte';
  import { boardByKey, queryStore } from '$lib/stores';
  import { BOARD_SETTINGS_SECTIONS, routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { provideSettings } from '$lib/board/settings/draft.svelte';

  let { children }: { children: Snippet } = $props();

  const boardKey = $derived(page.params.boardKey ?? '');
  const section = $derived(page.params.section ?? 'general');
  const boardStore = $derived(boardByKey(auth.uid, boardKey));
  const board = $derived($boardStore.board);
  const membersStore = $derived(
    queryStore<BoardMember>(board ? { path: paths.members(board.id) } : null),
  );
  const me = $derived(auth.uid ?? '');
  const role = $derived(board && me ? roleOf(board, me) : null);
  const members = $derived(
    $membersStore.data
      .map((m) => ({ uid: m.uid, name: m.name || m.email, email: m.email, role: m.role }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  provideSettings({
    get board() {
      return board!;
    },
    get me() {
      return me;
    },
    get role() {
      return role;
    },
    get isAdmin() {
      return role === 'admin';
    },
    get readOnly() {
      return role !== 'admin' || board?.archivedAt != null;
    },
    get members() {
      return members;
    },
  });
</script>

<svelte:head
  ><title>{board ? `Settings · ${board.key}` : 'Board settings'} — TaskManager</title></svelte:head
>

{#if $boardStore.loading}
  <div class="flex flex-col gap-3 p-6">
    <Skeleton height="1.5rem" width="16rem" /><Skeleton lines={5} />
  </div>
{:else if !board}
  <EmptyState title="Board not found" description="It may have been deleted, or you're not on it.">
    {#snippet action()}<Button href={routes.home()}>Back to your boards</Button>{/snippet}
  </EmptyState>
{:else}
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row md:px-8">
    <nav class="flex shrink-0 flex-col gap-1 md:w-52" aria-label="Board settings">
      <a
        href={routes.board(board.key)}
        class="mb-2 flex items-center gap-1.5 text-sm text-muted hover:text-text"
      >
        <ArrowLeft size={14} />
        {board.key} · {board.name}
      </a>
      <h1 class="mb-1 px-2 text-xs font-semibold tracking-wide text-subtle uppercase">Settings</h1>
      <ul class="flex gap-1 overflow-x-auto md:flex-col">
        {#each BOARD_SETTINGS_SECTIONS as s (s.id)}
          <li>
            <a
              href={routes.boardSettings(board.key, s.id)}
              aria-current={section === s.id ? 'page' : undefined}
              class="block rounded-md px-2 py-1.5 text-sm whitespace-nowrap {section === s.id
                ? 'bg-surface-2 font-medium text-text'
                : 'text-muted hover:bg-surface-2 hover:text-text'} {s.id === 'danger'
                ? 'md:mt-3'
                : ''}"
            >
              {s.label}
            </a>
          </li>
        {/each}
      </ul>
    </nav>
    <div class="min-w-0 flex-1">
      {#if board.archivedAt != null}
        <p role="status" class="mb-4 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          This board is archived — settings are read-only until it is restored (Danger zone).
        </p>
      {/if}
      {@render children()}
    </div>
  </div>
{/if}
