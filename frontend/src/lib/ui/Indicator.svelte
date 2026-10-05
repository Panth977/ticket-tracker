<!--
  @component
  indicators.html — an entity's mark: a board, a stage, an artifact, a memory,
  a workspace. Pass the entity (`of`, legacy fields read through indicatorOf)
  or an explicit `indicator`.

    color   a filled dot (xs/sm) or rounded square (md/lg)
    icon    the lucide icon, tinted
    emoji   the emoji
    image   the uploaded picture, rounded (URL from the file door, cached)

  ```svelte
  <Indicator of={board} seed={board.id} size="sm" />
  <Indicator indicator={{ kind: 'emoji', emoji: '🚀' }} size="lg" />
  ```
-->
<script lang="ts" module>
  export type IndicatorSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Pixel box per size. */
  export const INDICATOR_PX: Record<IndicatorSize, number> = {
    xs: 12,
    sm: 16,
    md: 20,
    lg: 32,
    xl: 48,
  };
</script>

<script lang="ts">
  import { indicatorOf, type Indicator } from '@tm/shared';
  import { Image as ImageIcon } from 'lucide-svelte';
  import { INDICATOR_ICON_COMPONENTS, iconLabel } from './indicatorIcons';
  import { indicatorImageUrl } from './indicatorImage';

  interface Props {
    /** Wins over `of`. */
    indicator?: Indicator | null;
    /** An entity with `indicator` and/or the legacy color / icon fields. */
    of?: { indicator?: Indicator | null; color?: string | null; icon?: string | null } | null;
    /** Picks the default colour when the entity has none (its id or name). */
    seed?: string;
    /** Drawn when the entity has no mark at all (memories: MEMORY_DEFAULT_INDICATOR). */
    fallback?: Indicator;
    size?: IndicatorSize;
    /** Accessible name; decorative (aria-hidden) when absent. */
    label?: string;
    class?: string;
  }
  let { indicator, of, seed = '', fallback, size = 'sm', label, class: klass = '' }: Props = $props();

  const ind = $derived(indicator ?? indicatorOf(of ?? {}, seed, fallback));
  const px = $derived(INDICATOR_PX[size]);
  const square = $derived(size === 'md' || size === 'lg' || size === 'xl');

  let imgSrc = $state<string | null>(null);
  let imgFailed = $state(false);
  $effect(() => {
    const path = ind.kind === 'image' ? ind.path : null;
    imgSrc = null;
    imgFailed = false;
    if (!path) return;
    let live = true;
    void indicatorImageUrl(path).then((u) => {
      if (!live) return;
      if (u) imgSrc = u;
      else imgFailed = true;
    });
    return () => {
      live = false;
    };
  });

  const IconComp = $derived(ind.kind === 'icon' ? INDICATOR_ICON_COMPONENTS[ind.icon] : null);
  const title = $derived(
    label ?? (ind.kind === 'icon' ? iconLabel(ind.icon) : ind.kind === 'emoji' ? ind.emoji : undefined),
  );
</script>

<span
  class="tm-indicator inline-flex shrink-0 items-center justify-center leading-none {klass}"
  style:width="{px}px"
  style:height="{px}px"
  data-indicator={ind.kind}
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
  title={label ? title : undefined}
>
  {#if ind.kind === 'color'}
    <span
      class="block {square ? 'rounded-md' : 'rounded-full'}"
      style:background={ind.color}
      style:width="{square ? px : Math.round(px * 0.62)}px"
      style:height="{square ? px : Math.round(px * 0.62)}px"
    ></span>
  {:else if ind.kind === 'icon' && IconComp}
    <IconComp size={Math.round(px * 0.9)} color={ind.color} strokeWidth={2.25} />
  {:else if ind.kind === 'emoji'}
    <span class="block select-none" style:font-size="{Math.round(px * 0.86)}px">{ind.emoji}</span>
  {:else if ind.kind === 'image'}
    {#if imgSrc && !imgFailed}
      <img
        src={imgSrc}
        alt=""
        class="block h-full w-full object-cover {size === 'xs' || size === 'sm'
          ? 'rounded-sm'
          : 'rounded-md'}"
        draggable="false"
        onerror={() => (imgFailed = true)}
      />
    {:else}
      <span
        class="flex h-full w-full items-center justify-center rounded-md bg-surface-2 text-muted"
      >
        {#if imgFailed}<ImageIcon size={Math.round(px * 0.7)} />{/if}
      </span>
    {/if}
  {/if}
</span>
