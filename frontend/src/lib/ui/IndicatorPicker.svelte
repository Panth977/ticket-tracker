<!--
  @component
  indicators.html — pick an entity's mark: Color | Icon | Emoji | Upload.
  Nothing is ever typed: colours and icons come from the palette and the icon
  list, an emoji is PICKED from the grid (the search box only filters it), an
  image is uploaded.

  ```svelte
  <IndicatorPicker bind:value={indicator} seed={name} />
  ```
-->
<script lang="ts">
  import {
    defaultIndicator,
    INDICATOR_COLORS,
    INDICATOR_ICONS,
    INDICATOR_IMAGE_TYPES,
    indicatorColor,
    type Indicator,
    type IndicatorIcon,
  } from '@tm/shared';
  import { Check, Search, Upload } from 'lucide-svelte';
  import Indicator_ from './Indicator.svelte';
  import { INDICATOR_ICON_COMPONENTS, iconLabel } from './indicatorIcons';
  import { checkIndicatorFile, uploadIndicatorImage } from './indicatorUpload';
  import { EMOJI_CATEGORIES, loadEmojiData, searchEmoji, type EmojiData } from './emoji';

  interface Props {
    value?: Indicator;
    /** Seeds the default when there is no value yet (the entity's name or id). */
    seed?: string;
    onchange?: (i: Indicator) => void;
    /** Injected in tests; defaults to the Storage upload. */
    upload?: (file: File) => Promise<string>;
  }
  let { value = $bindable(), seed = '', onchange, upload = uploadIndicatorImage }: Props = $props();

  const current = $derived(value ?? defaultIndicator(seed));
  type Tab = 'color' | 'icon' | 'emoji' | 'upload';
  const kindTab: Record<Indicator['kind'], Tab> = {
    color: 'color',
    icon: 'icon',
    emoji: 'emoji',
    image: 'upload',
  };
  // svelte-ignore state_referenced_locally
  let tab = $state<Tab>(kindTab[(value ?? defaultIndicator(seed)).kind]);

  function set(i: Indicator) {
    value = i;
    onchange?.(i);
  }

  const tint = $derived(indicatorColor(current));
  const hex = (c: string) => c.slice(1).toLowerCase();
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  // ── emoji ──
  let emoji = $state<EmojiData | null>(null);
  let emojiError = $state(false);
  let emojiCat = $state(EMOJI_CATEGORIES[0]!.id);
  let query = $state('');
  $effect(() => {
    if (tab !== 'emoji' || emoji) return;
    loadEmojiData().then(
      (d) => (emoji = d),
      () => (emojiError = true),
    );
  });
  const shown = $derived.by(() => {
    if (!emoji) return [];
    if (query.trim()) return searchEmoji(emoji.all, query);
    return emoji.categories.find((c) => c.id === emojiCat)?.items ?? [];
  });

  // ── upload ──
  let fileInput: HTMLInputElement | undefined = $state();
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);
  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    uploadError = checkIndicatorFile(file);
    if (uploadError) return;
    uploading = true;
    try {
      const path = await upload(file);
      set({ kind: 'image', path });
    } catch (err) {
      uploadError = err instanceof Error ? err.message : 'Upload failed — try again.';
    } finally {
      uploading = false;
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'color', label: 'Color' },
    { id: 'icon', label: 'Icon' },
    { id: 'emoji', label: 'Emoji' },
    { id: 'upload', label: 'Upload' },
  ];
</script>

<div data-testid="indicator-picker" class="flex w-[19rem] max-w-full flex-col gap-2 p-2">
  <div class="flex items-center gap-2">
    <Indicator_ indicator={current} size="lg" label="Current indicator" />
    <div
      class="flex min-w-0 flex-1 rounded-md bg-surface-2 p-0.5"
      role="tablist"
      aria-label="Indicator kind"
    >
      {#each tabs as t (t.id)}
        <button
          type="button"
          role="tab"
          data-testid="indicator-tab-{t.id}"
          aria-selected={tab === t.id}
          class="flex-1 rounded px-1 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent
            {tab === t.id ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text'}"
          onclick={() => (tab = t.id)}>{t.label}</button
        >
      {/each}
    </div>
  </div>

  {#if tab === 'color'}
    <div class="grid grid-cols-7 gap-1.5" role="group" aria-label="Colours">
      {#each INDICATOR_COLORS as c (c)}
        {@const on = current.kind === 'color' && same(current.color, c)}
        <button
          type="button"
          data-testid="indicator-color-{hex(c)}"
          aria-label="Colour {c}"
          aria-pressed={on}
          class="flex h-8 w-8 items-center justify-center rounded-md outline-none ring-offset-2 ring-offset-surface focus-visible:ring-2 focus-visible:ring-accent
            {on ? 'ring-2 ring-text' : ''}"
          style:background={c}
          onclick={() => set({ kind: 'color', color: c })}
        >
          {#if on}<Check size={16} color="white" strokeWidth={3} aria-hidden="true" />{/if}
        </button>
      {/each}
    </div>
  {:else if tab === 'icon'}
    <div class="flex flex-wrap gap-1" role="group" aria-label="Icon colour">
      {#each INDICATOR_COLORS as c (c)}
        {@const on = same(tint, c)}
        <button
          type="button"
          data-testid="indicator-tint-{hex(c)}"
          aria-label="Icon colour {c}"
          aria-pressed={on}
          class="h-5 w-5 rounded-full outline-none ring-offset-1 ring-offset-surface focus-visible:ring-2 focus-visible:ring-accent
            {on ? 'ring-2 ring-text' : ''}"
          style:background={c}
          onclick={() =>
            set({
              kind: 'icon',
              icon: current.kind === 'icon' ? current.icon : INDICATOR_ICONS[0],
              color: c,
            })}
        ></button>
      {/each}
    </div>
    <div class="grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto" role="group" aria-label="Icons">
      {#each INDICATOR_ICONS as id (id)}
        {@const Comp = INDICATOR_ICON_COMPONENTS[id as IndicatorIcon]}
        {@const on = current.kind === 'icon' && current.icon === id}
        <button
          type="button"
          data-testid="indicator-icon-{id}"
          aria-label={iconLabel(id)}
          title={iconLabel(id)}
          aria-pressed={on}
          class="flex h-8 w-8 items-center justify-center rounded-md outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent
            {on ? 'bg-surface-3' : ''}"
          onclick={() => set({ kind: 'icon', icon: id, color: tint })}
        >
          <Comp size={18} color={tint} strokeWidth={2.25} aria-hidden="true" />
        </button>
      {/each}
    </div>
  {:else if tab === 'emoji'}
    <label class="relative block">
      <span class="sr-only">Search emoji by name</span>
      <Search
        size={14}
        class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle"
        aria-hidden="true"
      />
      <input
        type="search"
        data-testid="indicator-emoji-search"
        placeholder="Search by name"
        autocomplete="off"
        bind:value={query}
        class="h-8 w-full rounded-md border border-line bg-surface pl-7 pr-2 text-sm outline-none focus:border-accent"
      />
    </label>
    {#if !query.trim()}
      <div class="flex gap-0.5 overflow-x-auto" role="group" aria-label="Emoji categories">
        {#each EMOJI_CATEGORIES as c (c.id)}
          <button
            type="button"
            data-testid="indicator-emoji-cat-{c.id}"
            aria-pressed={emojiCat === c.id}
            class="shrink-0 rounded px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent
              {emojiCat === c.id ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2'}"
            onclick={() => (emojiCat = c.id)}>{c.label}</button
          >
        {/each}
      </div>
    {/if}
    <div
      class="grid h-52 grid-cols-8 content-start gap-0.5 overflow-y-auto"
      role="group"
      aria-label="Emoji"
    >
      {#if emojiError}
        <p class="col-span-8 p-2 text-sm text-danger">Could not load the emoji.</p>
      {:else if !emoji}
        <p class="col-span-8 p-2 text-sm text-muted">Loading…</p>
      {:else if !shown.length}
        <p class="col-span-8 p-2 text-sm text-muted">No emoji match “{query.trim()}”.</p>
      {:else}
        {#each shown as e (e.emoji)}
          {@const on = current.kind === 'emoji' && current.emoji === e.emoji}
          <button
            type="button"
            data-testid="indicator-emoji"
            aria-label={e.name}
            title={e.name}
            aria-pressed={on}
            class="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent
              {on ? 'bg-surface-3' : ''}"
            onclick={() => set({ kind: 'emoji', emoji: e.emoji })}>{e.emoji}</button
          >
        {/each}
      {/if}
    </div>
  {:else}
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      {#if current.kind === 'image'}
        <Indicator_ indicator={current} size="xl" label="Uploaded image" />
      {/if}
      <input
        bind:this={fileInput}
        type="file"
        class="sr-only"
        data-testid="indicator-upload-input"
        accept={INDICATOR_IMAGE_TYPES.join(',')}
        onchange={onFile}
      />
      <button
        type="button"
        disabled={uploading}
        onclick={() => fileInput?.click()}
        class="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        <Upload size={14} aria-hidden="true" />
        {uploading ? 'Uploading…' : current.kind === 'image' ? 'Replace image' : 'Choose image'}
      </button>
      <p class="text-xs text-muted">PNG, JPEG, WebP, GIF or SVG · up to 1 MB · shown square</p>
      {#if uploadError}<p class="text-xs text-danger" role="alert">{uploadError}</p>{/if}
    </div>
  {/if}
</div>
