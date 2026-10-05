<!--
  <Avatar src={url} icon="claude" name="Builder" seed={id} size={24} />
  Picture, else an agent icon (shared AGENT_ICON_IDS, drawn in $lib/agents/icons),
  else initials: src > icon > initials. A brand icon is the real logo in its own
  colours on its own light/dark tile (`tint` draws it like the generic icons
  instead: one colour on the principal's stable colour).
-->
<script lang="ts">
  import { agentBrand, agentIcon } from '$lib/agents/icons';
  import BrandMark from '$lib/agents/icons/BrandMark.svelte';
  import { hueFor, initials } from '$lib/people/format';

  interface Props {
    src?: string | null;
    /** An agent icon id (types/agentIcons); unknown ids fall back to initials. */
    icon?: string | null;
    name?: string | null;
    /** Colour seed (uid) for the icon / initials fallback. */
    seed?: string;
    size?: number;
    /** Draw a brand icon in one tint on the principal's colour, not in brand colours. */
    tint?: boolean;
    class?: string;
    /** Decorative when a name is printed beside it. */
    decorative?: boolean;
  }
  let {
    src,
    icon,
    name,
    seed,
    size = 24,
    tint = false,
    class: cls = '',
    decorative = false,
  }: Props = $props();
  let failed = $state(false);
  $effect(() => {
    void src;
    failed = false;
  });
  const hue = $derived(hueFor(seed ?? name ?? '?'));
  const Icon = $derived(agentIcon(icon));
  const iconSize = $derived(Math.max(10, Math.round(size * 0.56)));
  const brand = $derived(agentBrand(icon));
  const showsPicture = $derived(!!src && !failed);
  // light-dark() follows the theme's color-scheme (app.css), so no class is
  // needed; the plain light value first is the fallback where it is unsupported.
  const tile = $derived(
    brand && !tint && !showsPicture
      ? `background:${brand.bg[0]};background:light-dark(${brand.bg[0]},${brand.bg[1]});` +
          `color:${brand.fg[0]};color:light-dark(${brand.fg[0]},${brand.fg[1]});` +
          'box-shadow:inset 0 0 0 1px light-dark(rgb(0 0 0/.1),rgb(255 255 255/.14))'
      : `background:hsl(${hue} 55% 88%);color:hsl(${hue} 45% 30%)`,
  );
</script>

<span
  class="inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold select-none {cls}"
  style="width:{size}px;height:{size}px;font-size:{Math.max(9, Math.round(size * 0.4))}px;{tile}"
  role={decorative ? 'presentation' : 'img'}
  aria-label={decorative ? undefined : (name ?? 'Unknown')}
>
  {#if showsPicture}
    <img
      {src}
      alt=""
      class="size-full object-cover"
      referrerpolicy="no-referrer"
      onerror={() => (failed = true)}
    />
  {:else if brand}
    <span class="grid place-items-center" data-icon={icon} aria-hidden="true">
      <BrandMark id={icon} size={Math.max(10, Math.round(size * 0.6))} mono={tint} />
    </span>
  {:else if Icon}
    <span class="grid place-items-center" data-icon={icon} aria-hidden="true">
      <Icon size={iconSize} />
    </span>
  {:else}
    <span aria-hidden="true">{initials(name)}</span>
  {/if}
</span>
