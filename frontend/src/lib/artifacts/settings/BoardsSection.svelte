<!--
  Artifact settings › Board access (owner only, artifacts.html §K): which
  boards' tickets the page may use through BackendDriver.tickets, and whether
  it may only read them or also change them. Each change is one
  artifactBoardAccessSet; the list shows the live document, so a click is
  final when the document says so.

  The grant is a ceiling, never a key: the page works as whoever is looking,
  so a viewer who is not on a board sees nothing of it.
-->
<script lang="ts">
  // Links come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { ExternalLink, Trash2 } from 'lucide-svelte';
  import { roleOf, type ArtifactBoardAccess } from '@tm/shared';
  import { command } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { myBoards } from '$lib/stores/app';
  import Button from '$lib/ui/Button.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Select from '$lib/ui/Select.svelte';
  import { useArtifactSettings } from './context.svelte';

  const s = useArtifactSettings();
  const a = $derived(s.artifact);
  const boardsQ = $derived(myBoards(auth.uid));
  const mine = $derived($boardsQ.data.filter((b) => b.archivedAt == null));
  const grants = $derived(a.boards ?? {});

  /** Granted boards, in the order they were given; one the owner left shows by id. */
  const rows = $derived(
    Object.entries(grants).map(([id, access]) => ({
      id,
      access,
      board: $boardsQ.data.find((b) => b.id === id) ?? null,
    })),
  );
  const addable = $derived(
    mine
      .filter((b) => !(b.id in grants))
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((b) => ({ value: b.id, label: `${b.key} · ${b.name}` })),
  );

  /** Write needs the owner to be able to edit there (the command refuses otherwise). */
  const canEdit = (b: (typeof mine)[number] | null) => {
    const r = b && auth.uid ? roleOf(b, auth.uid) : null;
    return r === 'admin' || r === 'editor';
  };

  let busy = $state<string | null>(null);
  async function set(boardId: string, access: ArtifactBoardAccess | null) {
    busy = boardId;
    try {
      await command(
        'artifactBoardAccessSet',
        { artifactId: a.id, boardId, access },
        { toast: 'Could not change board access' },
      );
    } catch {
      /* toasted; the list still shows the live document */
    } finally {
      busy = null;
    }
  }

  let adding = $state<string | null>(null);
  async function add() {
    if (!adding) return;
    await set(adding, 'read');
    adding = null;
  }
</script>

<Section
  title="Board access"
  description="Let this artifact read — or also change — the tickets of boards you are on, through BackendDriver.tickets. Anyone you share it with sees and changes only what they already can on that board."
>
  {#if rows.length}
    <ul class="flex flex-col divide-y divide-line rounded-lg border border-line" data-board-access>
      {#each rows as r (r.id)}
        <li class="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <div class="min-w-0 flex-1">
            {#if r.board}
              <a
                href={routes.board(r.board.key)}
                class="inline-flex items-center gap-1 font-medium hover:underline"
              >
                <span class="text-muted">{r.board.key}</span>
                {r.board.name}
                <ExternalLink size={12} aria-hidden="true" class="text-muted" />
              </a>
            {:else}
              <span class="text-muted">A board you are no longer on</span>
            {/if}
          </div>
          <div
            class="inline-flex overflow-hidden rounded-md border border-line text-sm"
            role="group"
            aria-label="Access to {r.board?.name ?? 'this board'}"
          >
            {#each [['read', 'Read'], ['write', 'Read & write']] as const as [value, label] (value)}
              <button
                type="button"
                class="px-2.5 py-1 {r.access === value
                  ? 'bg-surface-3 font-medium text-text'
                  : 'text-muted hover:bg-surface-2'}"
                aria-pressed={r.access === value}
                disabled={busy === r.id ||
                  r.access === value ||
                  (value === 'write' && !canEdit(r.board))}
                title={value === 'write' && !canEdit(r.board)
                  ? 'You need to be an editor or admin on this board'
                  : undefined}
                onclick={() => set(r.id, value)}>{label}</button
              >
            {/each}
          </div>
          <IconButton
            icon={Trash2}
            label="Remove {r.board?.name ?? 'this board'}"
            disabled={busy === r.id}
            onclick={() => set(r.id, null)}
          />
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-sm text-muted">No boards yet. The page's BackendDriver.tickets sees nothing.</p>
  {/if}

  <form
    class="flex flex-wrap items-end gap-2"
    onsubmit={(e) => {
      e.preventDefault();
      void add();
    }}
  >
    <Select
      label="Add a board"
      class="min-w-60 flex-1"
      options={addable}
      bind:value={adding}
      placeholder={addable.length ? 'Choose a board' : 'Every board you are on is added'}
      disabled={!addable.length}
    />
    <Button type="submit" disabled={!adding || busy !== null}>Add (read)</Button>
  </form>
</Section>
