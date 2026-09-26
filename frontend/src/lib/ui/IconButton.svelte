<!-- <IconButton icon={X} label="Close" onclick={close} /> — label is the accessible name and the tooltip. -->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { IconComponent, Size } from './types';

  interface Props extends Omit<HTMLButtonAttributes, 'children'> {
    icon: IconComponent;
    label: string;
    size?: Size;
    variant?: 'ghost' | 'secondary' | 'primary';
    href?: string;
    active?: boolean;
    class?: string;
  }
  let {
    icon: Icon,
    label,
    size = 'md',
    variant = 'ghost',
    href,
    active = false,
    type = 'button',
    class: cls = '',
    ...rest
  }: Props = $props();

  const box = $derived({ sm: 'size-6', md: 'size-8', lg: 'size-10' }[size]);
  const iconSize = $derived({ sm: 14, md: 16, lg: 20 }[size]);
  const tone = $derived(
    {
      ghost: 'text-muted hover:text-text hover:bg-surface-2 border-transparent',
      secondary: 'bg-surface text-text border-line hover:bg-surface-2',
      primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent',
    }[variant] + (active ? ' bg-surface-2 text-text' : ''),
  );
  const classes = $derived(
    `tm-press tm-tap inline-flex ${box} shrink-0 items-center justify-center rounded-md border transition-[color,background-color,border-color,transform] disabled:opacity-50 disabled:pointer-events-none ${tone} ${cls}`,
  );
</script>

{#if href}
  <a {href} class={classes} aria-label={label} title={label}
    ><Icon size={iconSize} aria-hidden="true" /></a
  >
{:else}
  <button
    {type}
    class={classes}
    aria-label={label}
    title={label}
    aria-pressed={active || undefined}
    {...rest}
  >
    <Icon size={iconSize} aria-hidden="true" />
  </button>
{/if}
