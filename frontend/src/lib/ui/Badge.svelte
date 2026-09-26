<!--
  <Badge tone="danger">Overdue</Badge>   <Badge color={tag.color}>bug</Badge>   <Badge count={3} />
  `color` (a board option colour) tints the badge from that colour.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Tone } from './types';

  interface Props {
    tone?: Tone;
    color?: string | null;
    count?: number;
    /** 99+ above this. */
    max?: number;
    dot?: boolean;
    class?: string;
    children?: Snippet;
  }
  let {
    tone = 'neutral',
    color,
    count,
    max = 99,
    dot = false,
    class: cls = '',
    children,
  }: Props = $props();

  const tones: Record<Tone, string> = {
    neutral: 'bg-surface-2 text-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  };
  const style = $derived(
    color
      ? `background: color-mix(in srgb, ${color} 18%, transparent); color: color-mix(in srgb, ${color} 75%, var(--tm-text));`
      : undefined,
  );
</script>

<span
  class="inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium whitespace-nowrap
    {color ? '' : tones[tone]} {cls}"
  {style}
>
  {#if dot}<span class="size-1.5 rounded-full" style="background: {color ?? 'currentColor'}"
    ></span>{/if}
  {#if count != null}{count > max ? `${max}+` : count}{/if}
  {@render children?.()}
</span>
