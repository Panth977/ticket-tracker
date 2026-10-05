<!--
  A card for an artifact or a memory, drawn exactly like a board's
  (account/BoardTile) so every "All …" page and a workspace page read the
  same: a glyph, a badge, the name, a line about it, small facts at the
  bottom. On a root list page `hidden` + `ontogglehidden` show the eye that
  hides it from the sidebar; on a workspace page only `onremove` (the
  workspace page never offers hiding — it is about the sidebar's root lists).
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import { Eye, EyeOff, X } from 'lucide-svelte';

  interface Props {
    href: string;
    name: string;
    glyph: string;
    description?: string | null;
    /** Top-left, like a board's key: e.g. the role ('Owner'). */
    badge?: string | null;
    /** Facts along the bottom. */
    meta?: Snippet;
    /** The left stripe (a board's colour; artifacts and memory use the accent). */
    color?: string;
    /** Root list pages only: is it hidden from the sidebar? (undefined = no eye) */
    hidden?: boolean;
    ontogglehidden?: (() => void) | null;
    /** Workspace page only: take it out of the workspace. */
    onremove?: (() => void) | null;
    onopen?: (() => void) | null;
    /** data-artifact / data-memory = the id, for the e2e suites. */
    dataKind: 'artifact' | 'memory';
    id: string;
  }
  let {
    href,
    name,
    glyph,
    description = null,
    badge = null,
    meta,
    color = 'var(--color-accent)',
    hidden,
    ontogglehidden = null,
    onremove = null,
    onopen = null,
    dataKind,
    id,
  }: Props = $props();

  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
</script>

<a
  {href}
  onclick={() => onopen?.()}
  class="group relative flex min-h-28 flex-col gap-2 overflow-hidden rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
  {...{ [`data-${dataKind}`]: id }}
>
  <span class="absolute inset-y-0 left-0 w-1" style:background={color} aria-hidden="true"></span>
  <div class="flex items-start gap-2">
    <span class="text-lg leading-none" aria-hidden="true">{glyph}</span>
    {#if badge}
      <span
        class="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted group-hover:bg-surface-3"
        >{badge}</span
      >
    {/if}
    <span class="flex-1"></span>
    {#if ontogglehidden && hidden !== undefined}
      <button
        type="button"
        class="-m-1 rounded p-1 transition-colors {hidden
          ? 'text-muted'
          : 'text-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100'} hover:text-text"
        aria-label={hidden ? `Show ${name} in the sidebar` : `Hide ${name} from the sidebar`}
        title={hidden ? 'Hidden from the sidebar — show it again' : 'Hide from the sidebar'}
        aria-pressed={hidden}
        data-hide-toggle
        onclick={stop(ontogglehidden)}
      >
        {#if hidden}<EyeOff size={16} aria-hidden="true" />{:else}<Eye
            size={16}
            aria-hidden="true"
          />{/if}
      </button>
    {/if}
    {#if onremove}
      <button
        type="button"
        class="-m-1 rounded p-1 text-subtle opacity-0 transition-colors group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
        aria-label="Remove {name} from this workspace"
        title="Remove from this workspace"
        onclick={stop(onremove)}
      >
        <X size={16} aria-hidden="true" />
      </button>
    {/if}
  </div>
  <h3 class="line-clamp-2 font-medium">{name}</h3>
  {#if description}<p class="line-clamp-2 text-sm text-muted">{description}</p>{/if}
  {#if ontogglehidden && hidden}<span class="text-xs text-subtle">Hidden from sidebar</span>{/if}
  {#if meta}<p class="mt-auto flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
      {@render meta()}
    </p>{/if}
</a>
