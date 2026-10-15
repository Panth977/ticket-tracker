<!--
  A card for an artifact or a bucket, drawn exactly like a board's
  (account/BoardTile) so an owner's page reads the same throughout: its
  indicator, a badge, the name, a line about it, small facts at the bottom.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import { indicatorColor, indicatorOf, type Indicator as IndicatorT } from '@tm/shared';
  import Indicator from '$lib/ui/Indicator.svelte';

  interface Props {
    href: string;
    name: string;
    /** The entity (indicators.html): its indicator, or the legacy fields indicatorOf reads. */
    of: { indicator?: IndicatorT | null; color?: string | null; icon?: string | null };
    /** Drawn when it has no mark (buckets: BUCKET_DEFAULT_INDICATOR). */
    fallback?: IndicatorT;
    description?: string | null;
    /** Top-left, like a board's key: e.g. the role ('Owner'). */
    badge?: string | null;
    /** Facts along the bottom. */
    meta?: Snippet;
    /** The left stripe; default: the indicator's colour. */
    color?: string;
    /** data-artifact / data-bucket = the id, for the e2e suites. */
    dataKind: 'artifact' | 'bucket';
    id: string;
  }
  let {
    href,
    name,
    of,
    fallback,
    description = null,
    badge = null,
    meta,
    color,
    dataKind,
    id,
  }: Props = $props();
</script>

<a
  {href}
  class="group relative flex min-h-28 flex-col gap-2 overflow-hidden rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
  {...{ [`data-${dataKind}`]: id }}
>
  <span
    class="absolute inset-y-0 left-0 w-1"
    style:background={color ?? indicatorColor(indicatorOf(of, id, fallback))}
    aria-hidden="true"
  ></span>
  <div class="flex items-start gap-2">
    <Indicator {of} seed={id} {fallback} size="md" />
    {#if badge}
      <span
        class="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted group-hover:bg-surface-3"
        >{badge}</span
      >
    {/if}
  </div>
  <h3 class="line-clamp-2 font-medium">{name}</h3>
  {#if description}<p class="line-clamp-2 text-sm text-muted">{description}</p>{/if}
  {#if meta}<p class="mt-auto flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
      {@render meta()}
    </p>{/if}
</a>
