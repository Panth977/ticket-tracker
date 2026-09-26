<!--
  A dropdown menu. The trigger snippet receives props to spread on a button:
  <Menu items={[{ label: 'Archive', icon: Archive, onSelect: archive }]}>
    {#snippet trigger(props)}<button {...props}>⋯</button>{/snippet}
  </Menu>
  Arrow keys / Home / End move, Enter selects, Escape closes.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import Popover from './Popover.svelte';
  import { uid } from './ids';
  import type { Placement } from './floating';
  import type { MenuItem } from './types';

  interface TriggerProps {
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
    onclick: (e: MouseEvent) => void;
    onkeydown: (e: KeyboardEvent) => void;
  }
  interface Props {
    items: MenuItem[];
    placement?: Placement;
    open?: boolean;
    trigger: Snippet<[TriggerProps]>;
    /** Extra content above the items (e.g. the Account menu's header). */
    header?: Snippet;
    class?: string;
  }
  let {
    items,
    placement = 'bottom-start',
    open = $bindable(false),
    trigger,
    header,
    class: cls = 'min-w-48',
  }: Props = $props();

  const id = uid('menu');
  let anchor: HTMLElement | null = $state(null);
  let list: HTMLElement | null = $state(null);

  function focusItem(i: number) {
    const els = list
      ? [...list.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')]
      : [];
    if (!els.length) return;
    els[(i + els.length) % els.length]?.focus();
  }
  async function show(focus: number) {
    open = true;
    await tick();
    focusItem(focus);
  }
  function current(): number {
    const els = list
      ? [...list.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')]
      : [];
    return els.indexOf(document.activeElement as HTMLElement);
  }
  function onListKey(e: KeyboardEvent) {
    const i = current();
    const moves: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: -1 };
    const to = moves[e.key];
    if (to !== undefined) {
      e.preventDefault();
      focusItem(to);
    } else if (e.key === 'Tab') open = false;
  }
  function select(item: MenuItem) {
    if (item.disabled) return;
    open = false;
    anchor?.focus();
    item.onSelect?.();
  }

  const triggerProps: TriggerProps = {
    'aria-haspopup': 'menu',
    get 'aria-expanded'() {
      return open;
    },
    'aria-controls': id,
    onclick: () => (open ? (open = false) : void show(0)),
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void show(0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        void show(-1);
      }
    },
  };
</script>

<span
  class="contents"
  {@attach (el: HTMLElement) => {
    const btn = el.querySelector<HTMLElement>('button,a,[tabindex]');
    if (btn) anchor = btn;
  }}
>
  {@render trigger(triggerProps)}
</span>

<Popover bind:open {anchor} {placement} role="presentation" class="py-1 {cls}">
  {#if header}{@render header()}{/if}
  <div bind:this={list} {id} role="menu" tabindex="-1" onkeydown={onListKey}>
    {#each items as item, i (i)}
      {#if item.separator}<div class="my-1 border-t border-line" role="separator"></div>{/if}
      {#if item.href && !item.disabled}
        <a
          href={item.href}
          role="menuitem"
          tabindex="-1"
          onclick={() => select(item)}
          class="flex h-8 items-center gap-2 px-3 text-sm outline-none hover:bg-surface-2 focus:bg-surface-2
            {item.danger ? 'text-danger' : 'text-text'}"
        >
          {#if item.icon}<item.icon size={15} aria-hidden="true" class="text-muted" />{/if}
          <span class="flex-1 truncate">{item.label}</span>
          {#if item.kbd}<span class="text-xs text-subtle">{item.kbd}</span>{/if}
        </a>
      {:else}
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          aria-disabled={item.disabled || undefined}
          onclick={() => select(item)}
          class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm outline-none hover:bg-surface-2 focus:bg-surface-2
            aria-disabled:opacity-50 {item.danger ? 'text-danger' : 'text-text'}"
        >
          {#if item.icon}<item.icon
              size={15}
              aria-hidden="true"
              class={item.danger ? '' : 'text-muted'}
            />{/if}
          <span class="flex-1 truncate">{item.label}</span>
          {#if item.kbd}<span class="text-xs text-subtle">{item.kbd}</span>{/if}
        </button>
      {/if}
    {/each}
  </div>
</Popover>
