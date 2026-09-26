<!--
  <Button variant="primary" onclick={save} loading={busy}>Save</Button>
  <Button href="/new-board" variant="ghost" icon={Plus}>New board</Button>
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { IconComponent, Size } from './types';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
  interface Props extends Omit<HTMLButtonAttributes, 'children'> {
    variant?: Variant;
    size?: Size;
    href?: string;
    loading?: boolean;
    icon?: IconComponent;
    /** Stretch to the container width. */
    block?: boolean;
    children?: Snippet;
    class?: string;
  }
  let {
    variant = 'secondary',
    size = 'md',
    href,
    loading = false,
    icon: Icon,
    block = false,
    disabled,
    type = 'button',
    children,
    class: cls = '',
    ...rest
  }: Props = $props();

  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent',
    secondary: 'bg-surface text-text border-line hover:bg-surface-2',
    ghost: 'bg-transparent text-text border-transparent hover:bg-surface-2',
    danger: 'bg-danger text-white border-transparent hover:opacity-90',
    link: 'bg-transparent text-accent border-transparent hover:underline px-0',
  };
  const sizes: Record<Size, string> = {
    sm: 'h-7 px-2 text-xs gap-1',
    md: 'h-8 px-3 text-sm gap-1.5',
    lg: 'h-10 px-4 text-base gap-2',
  };
  const classes = $derived(
    `tm-press tm-tap inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] select-none
     disabled:opacity-50 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${block ? 'w-full' : ''} ${cls}`,
  );
  const iconSize = $derived(size === 'sm' ? 14 : size === 'lg' ? 18 : 16);
</script>

{#snippet inner()}
  {#if loading}
    <span
      class="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    ></span>
  {:else if Icon}
    <Icon size={iconSize} aria-hidden="true" />
  {/if}
  {@render children?.()}
{/snippet}

{#if href && !disabled}
  <a {href} class={classes} aria-busy={loading || undefined}>{@render inner()}</a>
{:else}
  <button
    {type}
    class={classes}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    {...rest}
  >
    {@render inner()}
  </button>
{/if}
