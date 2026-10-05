<!--
  Settings › Memory (memory.html §D) — for a board (admins) or an artifact
  (its owner): which of MY memories it may use, and whether only to read or
  also to write. Each change is one memoryGrantSet; the list shows the live
  memory documents, so a click is final when the document says so.

  A grant is a ceiling, never a key: everyone still does only what their own
  role allows (on the board, or — for an artifact — as whoever is looking).
-->
<script lang="ts">
  // Links come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { ExternalLink } from 'lucide-svelte';
  import { memoryAppPath, memoryGlyph, type MemoryGrant } from '@tm/shared';
  import { command } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { grantOf, ownedMemories, type GrantTarget } from './owned';

  interface Props {
    target: GrantTarget;
    /** One line under the title: what a grant means HERE. */
    description: string;
  }
  let { target, description }: Props = $props();

  const memoriesQ = $derived(ownedMemories(auth.uid));
  const rows = $derived(
    $memoriesQ.data
      .filter((m) => m.archivedAt == null || grantOf(m, target))
      .map((m) => ({ m, grant: grantOf(m, target) })),
  );

  let busy = $state<string | null>(null);
  async function set(memoryId: string, access: MemoryGrant | null) {
    busy = memoryId;
    try {
      await command(
        'memoryGrantSet',
        { memoryId, ...target, access },
        { toast: 'Could not change memory access' },
      );
    } catch {
      /* toasted; the list still shows the live document */
    } finally {
      busy = null;
    }
  }

  const CHOICES = [
    [null, 'None'],
    ['read', 'Read'],
    ['write', 'Read & write'],
  ] as const;
</script>

<Section title="Memory" {description}>
  {#if $memoriesQ.loading}
    <p class="text-sm text-muted">Loading your memories…</p>
  {:else if rows.length}
    <ul class="flex flex-col divide-y divide-line rounded-lg border border-line" data-memory-grants>
      {#each rows as r (r.m.id)}
        <li class="flex flex-wrap items-center gap-3 px-3 py-2.5" data-memory-grant={r.m.id}>
          <div class="min-w-0 flex-1">
            <a
              href={memoryAppPath(r.m.id)}
              class="inline-flex items-center gap-1.5 font-medium hover:underline"
            >
              <span aria-hidden="true">{memoryGlyph(r.m)}</span>
              {r.m.name}
              <ExternalLink size={12} aria-hidden="true" class="text-muted" />
            </a>
            <span class="block text-xs text-muted">
              {r.m.stats.files}
              {r.m.stats.files === 1 ? 'file' : 'files'}{#if r.m.archivedAt != null}
                · archived{/if}
            </span>
          </div>
          <div
            class="inline-flex overflow-hidden rounded-md border border-line text-sm"
            role="group"
            aria-label="Access to {r.m.name}"
          >
            {#each CHOICES as [value, label] (label)}
              <button
                type="button"
                class="px-2.5 py-1 {r.grant === value
                  ? 'bg-surface-3 font-medium text-text'
                  : 'text-muted hover:bg-surface-2'}"
                aria-pressed={r.grant === value}
                disabled={busy === r.m.id || r.grant === value}
                onclick={() => set(r.m.id, value)}>{label}</button
              >
            {/each}
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-sm text-muted">
      You have no memories yet. Make one under Memory in the sidebar, then come back to share it
      here.
    </p>
  {/if}
</Section>
