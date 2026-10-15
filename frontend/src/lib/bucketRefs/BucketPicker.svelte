<!--
  "Attach from bucket" (bucket.html §E): the buckets granted to this board,
  then one bucket's tree with a checkbox per file. Nothing is uploaded: the
  chosen files go out as bucketRefs and every ticket that points at a file
  sees its current version.

  Reads go through the commands (bucketList / bucketTree), because a board
  member may reach a bucket only through the grant and not read its
  documents directly.
-->
<script lang="ts">
  import Indicator from '$lib/ui/Indicator.svelte';
  import { ChevronRight, Folder, Loader2 } from 'lucide-svelte';
  import {
    BUCKET_DEFAULT_INDICATOR,
    formatBytes,
    type BucketNodeOut,
    type BucketOut,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import { KIND_ICON, kindOf } from '$lib/files';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { pickerRows, toggleNode, toPicks, type BucketPick } from './pick';

  interface Props {
    open: boolean;
    boardId: string;
    /** How many more files the message can carry. */
    room: number;
    onpick: (picks: BucketPick[]) => void;
  }
  let { open = $bindable(false), boardId, room, onpick }: Props = $props();

  let buckets = $state<BucketOut[] | null>(null);
  let failed = $state(false);
  let current = $state<BucketOut | null>(null);
  let nodes = $state<BucketNodeOut[] | null>(null);
  let unfolded = $state<Set<string>>(new Set());
  let selected = $state<Set<string>>(new Set());
  let filter = $state('');

  // A fresh picker every time it opens.
  $effect(() => {
    if (!open) return;
    buckets = null;
    failed = false;
    current = null;
    nodes = null;
    selected = new Set();
    filter = '';
    command('bucketList', { boardId }, { toast: false })
      .then((r) => {
        buckets = r.buckets;
        if (r.buckets.length === 1) void choose(r.buckets[0]!);
      })
      .catch(() => (failed = true));
  });

  async function choose(m: BucketOut) {
    current = m;
    nodes = null;
    selected = new Set();
    unfolded = new Set();
    try {
      nodes = (await command('bucketTree', { bucketId: m.id }, { toast: false })).nodes;
    } catch {
      nodes = [];
      failed = true;
    }
  }

  const rows = $derived(nodes ? pickerRows(nodes, unfolded, filter) : []);
  const files = $derived(nodes?.filter((n) => n.kind === 'file').length ?? 0);

  /** Immutable: a new Set each time, assigned (state holds plain Sets). */
  const fold = (id: string) =>
    (unfolded = new Set(
      unfolded.has(id) ? [...unfolded].filter((x) => x !== id) : [...unfolded, id],
    ));

  function attach() {
    if (!current || !nodes || !selected.size) return;
    onpick(toPicks(current, nodes, selected));
    open = false;
  }
</script>

<Dialog
  bind:open
  title="Attach from bucket"
  size="md"
  description="Files stay in the bucket. The ticket points at them, so an edit there shows here too."
>
  <div class="flex min-h-64 flex-col gap-3" data-bucket-picker>
    {#if failed && !buckets}
      <p class="text-sm text-danger">Could not load this board's buckets.</p>
    {:else if buckets === null}
      <p class="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} class="animate-spin" /> Loading…
      </p>
    {:else if !buckets.length}
      <p class="text-sm text-muted">
        No bucket is shared with this board yet. A board admin can add one in Settings › Subscriptions.
      </p>
    {:else}
      {#if buckets.length > 1 || !current}
        <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="Buckets">
          {#each buckets as m (m.id)}
            <button
              type="button"
              role="tab"
              aria-selected={current?.id === m.id}
              class="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm
                {current?.id === m.id
                ? 'border-accent bg-accent-soft font-medium text-text'
                : 'border-line text-muted hover:bg-surface-2'}"
              onclick={() => choose(m)}
              ><Indicator
                of={m}
                seed={m.id}
                fallback={BUCKET_DEFAULT_INDICATOR}
                size="sm"
              />{m.name}</button
            >
          {/each}
        </div>
      {/if}
      {#if current}
        {#if nodes === null}
          <p class="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={14} class="animate-spin" /> Loading {current.name}…
          </p>
        {:else if !files}
          <p class="text-sm text-muted">{current.name} has no files yet.</p>
        {:else}
          <Input
            label="Find a file"
            bind:value={filter}
            placeholder="Name or path"
            autocomplete="off"
          />
          <ul
            class="flex max-h-80 flex-col overflow-y-auto rounded-lg border border-line py-1"
            aria-label="Files in {current.name}"
          >
            {#each rows as r (r.node.id)}
              {@const n = r.node}
              <li style="padding-left:{0.5 + r.depth * 1.1}rem" class="pr-2">
                {#if n.kind === 'folder'}
                  <button
                    type="button"
                    class="flex h-7 w-full items-center gap-1.5 rounded text-left text-sm text-muted hover:bg-surface-2 hover:text-text"
                    aria-expanded={r.open}
                    onclick={() => fold(n.id)}
                  >
                    <ChevronRight
                      size={13}
                      class="shrink-0 transition-transform {r.open ? 'rotate-90' : ''}"
                    />
                    <Folder size={14} class="shrink-0" />
                    <span class="truncate">{n.name}</span>
                  </button>
                {:else if n.file}
                  {@const Icon = KIND_ICON[kindOf({ name: n.name, mime: n.file.mime })]}
                  <label
                    class="flex h-7 cursor-pointer items-center gap-2 rounded pl-5 text-sm hover:bg-surface-2"
                    data-bucket-file={n.path}
                  >
                    <input
                      type="checkbox"
                      class="accent-accent"
                      checked={selected.has(n.id)}
                      disabled={!selected.has(n.id) && selected.size >= room}
                      onchange={() => (selected = toggleNode(selected, n, room))}
                    />
                    <Icon size={14} class="shrink-0 text-muted" />
                    <span class="min-w-0 flex-1 truncate">{n.name}</span>
                    <span class="shrink-0 text-xs text-muted">{formatBytes(n.file.size)}</span>
                  </label>
                {/if}
              </li>
            {:else}
              <li class="px-3 py-2 text-sm text-muted">No file matches “{filter}”.</li>
            {/each}
          </ul>
        {/if}
      {/if}
    {/if}
  </div>
  {#snippet footer()}
    <span class="mr-auto text-xs text-muted"
      >{selected.size ? `${selected.size} selected` : ''}{#if room <= 0}
        A message carries at most this many files.{/if}</span
    >
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" disabled={!selected.size} onclick={attach}
      >Attach{selected.size ? ` ${selected.size}` : ''}</Button
    >
  {/snippet}
</Dialog>
