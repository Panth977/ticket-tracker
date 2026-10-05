<!--
  Memory settings › Board & artifact access (memory.html §D): which boards'
  members and which artifacts' pages may use this memory — read here, set
  where they live (board settings › Memory, artifact settings › Memory), since
  a grant needs both sides.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { AppWindow, SquareKanban } from 'lucide-svelte';
  import type { MemoryGrant } from '@tm/shared';
  import { artifactGlyph, myArtifacts } from '$lib/artifacts/store';
  import Section from '$lib/board/settings/Section.svelte';
  import { routes } from '$lib/layout/routes';
  import { myBoards } from '$lib/stores';
  import { useMemorySettings } from './context.svelte';

  const s = useMemorySettings();
  const m = $derived(s.memory);
  const boardsQ = $derived(myBoards(s.me));
  const artifactsQ = $derived(myArtifacts(s.me));
  const boardById = $derived(new Map($boardsQ.data.map((b) => [b.id, b])));
  const artifactById = $derived(new Map($artifactsQ.data.map((a) => [a.id, a])));

  const LABEL: Record<MemoryGrant, string> = {
    read: 'Read — browse, preview, attach to tickets',
    write: 'Read & write — editors and admins may also change files',
  };
  const boards = $derived(Object.entries(m.boards ?? {}));
  const artifacts = $derived(Object.entries(m.artifacts ?? {}));
</script>

<Section
  title="Board & artifact access"
  description="A board's members (people and agents) and an artifact's page may use this memory only if it is granted here. Each grant is a ceiling: nobody gets more than their own role allows. The memory's owner grants it from the board's or the artifact's settings."
>
  <div class="flex flex-col gap-6">
    <section class="flex flex-col gap-2" aria-label="Boards">
      <h3 class="flex items-center gap-1.5 text-sm font-medium">
        <SquareKanban size={14} /> Boards <span class="text-muted">{boards.length}</span>
      </h3>
      {#if boards.length}
        <ul class="divide-y divide-line rounded-xl border border-line bg-surface">
          {#each boards as [id, access] (id)}
            {@const b = boardById.get(id)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm" data-grant-board={id}>
              {#if b}
                <a
                  class="min-w-0 flex-1 truncate hover:underline"
                  href={routes.boardSettings(b.key)}
                  ><span class="font-mono text-xs text-muted">{b.key}</span> {b.name}</a
                >
              {:else}
                <span class="min-w-0 flex-1 truncate text-muted">A board you are not on</span>
              {/if}
              <span class="text-xs text-muted">{LABEL[access]}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-sm text-muted">
          No board uses it yet. Open a board's Settings › Memory to grant it.
        </p>
      {/if}
    </section>
    <section class="flex flex-col gap-2" aria-label="Artifacts">
      <h3 class="flex items-center gap-1.5 text-sm font-medium">
        <AppWindow size={14} /> Artifacts <span class="text-muted">{artifacts.length}</span>
      </h3>
      {#if artifacts.length}
        <ul class="divide-y divide-line rounded-xl border border-line bg-surface">
          {#each artifacts as [id, access] (id)}
            {@const a = artifactById.get(id)}
            <li
              class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm"
              data-grant-artifact={id}
            >
              {#if a}
                <a class="min-w-0 flex-1 truncate hover:underline" href={routes.artifact(a.id)}
                  >{artifactGlyph(a)} {a.name}</a
                >
              {:else}
                <span class="min-w-0 flex-1 truncate text-muted"
                  >An artifact not shared with you</span
                >
              {/if}
              <span class="text-xs text-muted">{access === 'write' ? 'Read & write' : 'Read'}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-sm text-muted">
          No artifact uses it yet. Open an artifact's Settings › Memory to grant it.
        </p>
      {/if}
    </section>
  </div>
</Section>
