<!--
  ⌘K. Mounted once by the Shell. Providers (palette.register) supply items;
  ↑/↓ move, ↵ runs, Esc closes. Async providers are debounced and stale
  answers are dropped.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { Search } from 'lucide-svelte';
  import { palette, type PaletteItem } from './palette.svelte';

  let dialog: HTMLDialogElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  let groups = $state.raw<{ group: string; items: PaletteItem[] }[]>([]);
  let active = $state(0);
  let loading = $state(false);
  let seq = 0;

  const flat = $derived(groups.flatMap((g) => g.items));

  $effect(() => {
    if (!dialog) return;
    if (palette.isOpen && !dialog.open) {
      dialog.showModal();
      queueMicrotask(() => input?.select());
    } else if (!palette.isOpen && dialog.open) dialog.close();
  });

  // Re-query whenever the text or the provider list changes.
  $effect(() => {
    const q = palette.query;
    const providers = [...palette.providers].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    if (!palette.isOpen) return;
    const mine = ++seq;
    const timer = setTimeout(
      async () => {
        loading = true;
        const results = await Promise.all(
          providers.map(async (p) => {
            if (q.trim().length < (p.minQuery ?? 0))
              return { group: p.group, items: [] as PaletteItem[] };
            try {
              return { group: p.group, items: (await p.search(q)).slice(0, 8) };
            } catch {
              return { group: p.group, items: [] as PaletteItem[] };
            }
          }),
        );
        if (mine !== seq) return;
        groups = results.filter((g) => g.items.length);
        active = 0;
        loading = false;
      },
      q ? 90 : 0,
    );
    return () => clearTimeout(timer);
  });

  async function run(item: PaletteItem | undefined) {
    if (!item) return;
    palette.close();
    if (item.href) await goto(item.href);
    else await item.run?.();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = flat.length ? (active + 1) % flat.length : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = flat.length ? (active - 1 + flat.length) % flat.length : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void run(flat[active]);
    }
  }
  $effect(() => {
    void active;
    dialog?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  });
</script>

<dialog
  bind:this={dialog}
  aria-label="Command palette"
  onclose={() => palette.close()}
  onclick={(e) => e.target === dialog && dialog?.close()}
  class="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl rounded-xl border border-line bg-surface p-0 text-text shadow-pop"
>
  {#if palette.isOpen}
    <div class="flex items-center gap-2 border-b border-line px-3">
      <Search size={16} class="text-muted" aria-hidden="true" />
      <input
        bind:this={input}
        bind:value={palette.query}
        {onkeydown}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={flat.length ? `palette-${active}` : undefined}
        placeholder="Search tickets, boards, people, commands"
        class="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-subtle"
      />
      {#if loading}<span
          class="size-3.5 animate-spin rounded-full border-2 border-muted border-t-transparent"
        ></span>{/if}
    </div>
    <div id="palette-list" role="listbox" class="max-h-[50vh] overflow-y-auto py-1">
      {#if !groups.length && !loading}
        <p class="px-4 py-6 text-center text-sm text-muted">No results</p>
      {/if}
      {#each groups as g (g.group)}
        <div class="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
          {g.group}
        </div>
        {#each g.items as item (item.id)}
          {@const idx = flat.indexOf(item)}
          <div
            id="palette-{idx}"
            data-idx={idx}
            role="option"
            tabindex="-1"
            aria-selected={idx === active}
            onclick={() => run(item)}
            onkeydown={(e) => e.key === 'Enter' && run(item)}
            onpointermove={() => (active = idx)}
            class="mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm
              {idx === active ? 'bg-surface-2' : ''}"
          >
            {#if item.icon}<item.icon
                size={16}
                class="shrink-0 text-muted"
                aria-hidden="true"
              />{/if}
            <span class="flex-1 truncate">{item.label}</span>
            {#if item.hint}<span class="truncate text-xs text-muted">{item.hint}</span>{/if}
            {#if item.kbd}<span class="text-xs text-subtle">{item.kbd}</span>{/if}
          </div>
        {/each}
      {/each}
    </div>
  {/if}
</dialog>
