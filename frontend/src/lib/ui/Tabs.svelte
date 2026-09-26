<!--
  Tabs as buttons (bind:value) or as links (items with href — URL holds state).
  <Tabs items={[{ id: 'thread', label: 'Thread', count: 14 }]} bind:value={tab} />
  The active tab's underline slides to the new tab (agents.html § K › Motion).
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { IconComponent } from './types';

  export interface TabItem {
    id: string;
    label: string;
    href?: string;
    count?: number;
    icon?: IconComponent;
    disabled?: boolean;
  }
  interface Props {
    items: TabItem[];
    value?: string;
    label?: string;
    onchange?: (id: string) => void;
    class?: string;
  }
  let {
    items,
    value = $bindable(items[0]?.id ?? ''),
    label = 'Tabs',
    onchange,
    class: cls = '',
  }: Props = $props();

  let list: HTMLElement | undefined = $state();
  /** The sliding underline: left + width of the selected tab. */
  let bar = $state<{ left: number; width: number } | null>(null);
  $effect(() => {
    void value;
    void items;
    if (!list) return;
    const measure = () => {
      const el = list?.querySelector<HTMLElement>(
        `[data-tab="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value}"]`,
      );
      bar = el ? { left: el.offsetLeft, width: el.offsetWidth } : null;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  });
  function pick(id: string) {
    value = id;
    onchange?.(id);
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const enabled = items.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.id === value);
    const next = enabled[(i + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (!next) return;
    e.preventDefault();
    pick(next.id);
    list?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  }
</script>

<div
  bind:this={list}
  role="tablist"
  aria-label={label}
  tabindex="-1"
  {onkeydown}
  class="relative flex items-center gap-1 overflow-x-auto pb-0.5 {cls}"
>
  {#if bar}
    <span
      class="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-accent transition-[left,width] duration-200 ease-out"
      style="left:{bar.left + 6}px;width:{Math.max(0, bar.width - 12)}px"
      aria-hidden="true"
    ></span>
  {/if}
  {#each items as t (t.id)}
    {@const selected = t.id === value}
    {@const classes = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors
      ${selected ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}
      ${t.disabled ? 'pointer-events-none opacity-50' : ''}`}
    {#if t.href}
      <a
        href={t.href}
        role="tab"
        data-tab={t.id}
        aria-selected={selected}
        tabindex={selected ? 0 : -1}
        class={classes}
        onclick={() => pick(t.id)}
      >
        {#if t.icon}<t.icon size={15} aria-hidden="true" />{/if}{t.label}
        {#if t.count != null}<span class="text-xs text-subtle">{t.count}</span>{/if}
      </a>
    {:else}
      <button
        type="button"
        role="tab"
        data-tab={t.id}
        aria-selected={selected}
        tabindex={selected ? 0 : -1}
        disabled={t.disabled}
        class={classes}
        onclick={() => pick(t.id)}
      >
        {#if t.icon}<t.icon size={15} aria-hidden="true" />{/if}{t.label}
        {#if t.count != null}<span class="text-xs text-subtle">{t.count}</span>{/if}
      </button>
    {/if}
  {/each}
</div>
