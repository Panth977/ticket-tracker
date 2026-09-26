<!--
  <Avatar src={url} icon="claude" name="Builder" seed={id} size={24} />
  Picture, else an agent icon (shared AGENT_ICON_IDS, drawn in $lib/agents/icons)
  on the principal's stable colour, else initials on it: src > icon > initials.
-->
<script lang="ts">
  import { agentIcon } from '$lib/agents/icons';
  import { hueFor, initials } from '$lib/people/format';

  interface Props {
    src?: string | null;
    /** An agent icon id (types/agentIcons); unknown ids fall back to initials. */
    icon?: string | null;
    name?: string | null;
    /** Colour seed (uid) for the icon / initials fallback. */
    seed?: string;
    size?: number;
    class?: string;
    /** Decorative when a name is printed beside it. */
    decorative?: boolean;
  }
  let { src, icon, name, seed, size = 24, class: cls = '', decorative = false }: Props = $props();
  let failed = $state(false);
  $effect(() => {
    void src;
    failed = false;
  });
  const hue = $derived(hueFor(seed ?? name ?? '?'));
  const Icon = $derived(agentIcon(icon));
  const iconSize = $derived(Math.max(10, Math.round(size * 0.56)));
</script>

<span
  class="inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold select-none {cls}"
  style="width:{size}px;height:{size}px;font-size:{Math.max(9, Math.round(size * 0.4))}px;
    background:hsl({hue} 55% 88%);color:hsl({hue} 45% 30%)"
  role={decorative ? 'presentation' : 'img'}
  aria-label={decorative ? undefined : (name ?? 'Unknown')}
>
  {#if src && !failed}
    <img
      {src}
      alt=""
      class="size-full object-cover"
      referrerpolicy="no-referrer"
      onerror={() => (failed = true)}
    />
  {:else if Icon}
    <span class="grid place-items-center" data-icon={icon} aria-hidden="true">
      <Icon size={iconSize} />
    </span>
  {:else}
    <span aria-hidden="true">{initials(name)}</span>
  {/if}
</span>
