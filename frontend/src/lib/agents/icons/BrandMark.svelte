<!--
  <BrandMark id="claude" size={20} />
  The one drawing of a brand agent icon (art: ./brands.ts): the real mark in
  its own colours — `currentColor` parts take the tile's light/dark `fg`, set
  by the avatar. `mono` draws the whole mark in currentColor instead (a single
  tint on any background). Nothing is drawn for an id without art.
-->
<script lang="ts">
  import { agentBrand } from './index';

  interface Props {
    id: string | null | undefined;
    size?: number;
    mono?: boolean;
    class?: string;
  }
  let { id, size = 24, mono = false, class: cls = '' }: Props = $props();
  const uid = $props.id();
  const art = $derived(agentBrand(id));
  const body = $derived(!mono && art?.body ? art.body.replaceAll('{id}', `${uid}-`) : null);
</script>

{#if art}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox={body ? (art.bodyBox ?? art.box) : art.box}
    class={cls}
    aria-hidden="true"
    data-brand={id}
  >
    {#if body}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- static art from ./brands.ts -->
      {@html body}
    {:else}
      <path d={art.mono} fill="currentColor" fill-rule={art.evenodd ? 'evenodd' : undefined} />
    {/if}
  </svg>
{/if}
