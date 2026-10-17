<!--
  THE ENTRIES of one dictionary (docs/plan/dictionary.html): an ordered table
  of KEY → VALUE rows. Each value is Text (stored as a JSON string, typed
  as-is) or JSON (any JSON value — a number, true/false, null, an array, an
  object — typed as JSON and checked with JSON.parse, the error shown under it).

  Rows can be added, deleted and moved up / down; the search box filters by
  key. Save sends the whole list once — dictionarySet { replace,
  expectedUpdatedAt } — so a change made elsewhere since this was loaded is a
  409, said in words with a Reload. Unsaved changes are guarded (leaving the
  page asks first).

  Where the entries come from: the content document, live, for the
  dictionary's own people (`live`); anyone else (a board grant, an artifact's
  page) reads them with dictionaryGet. Without `writable` it only shows them.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import {
    ArrowDown,
    ArrowUp,
    Plus,
    RotateCcw,
    Save,
    Search,
    Trash2,
    TriangleAlert,
  } from 'lucide-svelte';
  import { DICTIONARY_ENTRIES_MAX, entriesOut } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { Button, IconButton, Skeleton, toast } from '$lib/ui';
  import {
    dictionaryContent,
    duplicateKeys,
    keyError,
    moveRow,
    newRid,
    replaceOf,
    retype,
    rowsOf,
    rowsSignature,
    valueOf,
    type EntryRow,
    type EntryType,
  } from './store';

  interface Props {
    dictionaryId: string;
    /** The viewer may change entries (their reach, and the artifact's grant on its page). */
    writable?: boolean;
    /** Read the content document directly (the viewer is one of its people). */
    live?: boolean;
    /** Called after a save, with the new entry count. */
    onsaved?: (entries: number) => void;
  }
  let { dictionaryId, writable = false, live = true, onsaved }: Props = $props();

  // ── what is stored ─────────────────────────────────────────────────────────
  interface Base {
    rows: EntryRow[];
    updatedAt: number | null;
  }
  let base = $state.raw<Base | null>(null);
  let loadFailed = $state(false);

  const contentQ = $derived(live ? dictionaryContent(dictionaryId) : null);
  /** The direct read was refused (not one of its people): use the API instead. */
  const viaApi = $derived(!live || !!$contentQ?.error);

  // Live: every snapshot is the new base.
  $effect(() => {
    if (viaApi || !contentQ) return;
    const s = $contentQ;
    if (!s || s.loading) return;
    const next = { rows: rowsOf(entriesOut(s.data)), updatedAt: s.data?.updatedAt ?? null };
    untrack(() => takeBase(next));
  });

  // Via the API: once, and again on Reload.
  let fetchVersion = $state(0);
  $effect(() => {
    if (!viaApi) return;
    void fetchVersion;
    const id = dictionaryId;
    loadFailed = false;
    command('dictionaryGet', { dictionaryId: id }, { toast: false }).then(
      (r) => {
        if (id !== dictionaryId) return;
        untrack(() =>
          takeBase({ rows: rowsOf(r.entries), updatedAt: r.entriesUpdatedAt }, { force: true }),
        );
      },
      () => id === dictionaryId && (loadFailed = true),
    );
  });

  // ── what is being edited ───────────────────────────────────────────────────
  let rows = $state<EntryRow[]>([]);
  /** The base the draft started from. */
  let from = $state.raw<Base | null>(null);
  /** The stored entries changed under unsaved edits (or a save was refused for it). */
  let stale = $state(false);
  let conflict = $state(false);

  const dirty = $derived(!!from && rowsSignature(rows) !== rowsSignature(from.rows));

  function takeBase(next: Base, o: { force?: boolean } = {}) {
    const prev = base;
    base = next;
    if (o.force || !from || !dirty) {
      from = next;
      rows = next.rows.map((r) => ({ ...r }));
      stale = false;
      conflict = false;
      return;
    }
    if (prev && next.updatedAt !== from.updatedAt) stale = true;
  }

  /** Throw the draft away and start again from what is stored now. */
  function reload() {
    if (viaApi) {
      from = null;
      fetchVersion++;
      return;
    }
    if (base) takeBase(base, { force: true });
  }
  /** Drop my changes: back to what is stored (the newest seen). */
  function discard() {
    if (base) takeBase(base, { force: true });
  }

  // ── row checks ─────────────────────────────────────────────────────────────
  const dupes = $derived(duplicateKeys(rows));
  const keyErrors = $derived(rows.map((r) => keyError(r.key, dupes)));
  const valueErrors = $derived(
    rows.map((r) => {
      const v = valueOf(r);
      return v.ok ? null : v.error;
    }),
  );
  const invalid = $derived(keyErrors.some(Boolean) || valueErrors.some(Boolean));
  const full = $derived(rows.length >= DICTIONARY_ENTRIES_MAX);

  // ── search ─────────────────────────────────────────────────────────────────
  let query = $state('');
  const q = $derived(query.trim().toLowerCase());
  const visible = $derived(
    rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || r.key.toLowerCase().includes(q)),
  );

  // ── editing ────────────────────────────────────────────────────────────────
  let focusRid = $state<string | null>(null);
  function add() {
    if (full) return;
    const r: EntryRow = { rid: newRid(), key: '', type: 'text', text: '' };
    rows = [...rows, r];
    query = '';
    focusRid = r.rid;
  }
  function focusKey(el: HTMLInputElement, rid: string) {
    if (rid === focusRid) {
      el.focus();
      focusRid = null;
    }
  }
  const setKey = (i: number, key: string) => (rows[i] = { ...rows[i]!, key });
  const setText = (i: number, text: string) => (rows[i] = { ...rows[i]!, text });
  const setType = (i: number, type: EntryType) => (rows[i] = retype(rows[i]!, type));
  const move = (i: number, by: -1 | 1) => (rows = moveRow(rows, i, by));
  const remove = (i: number) => (rows = rows.filter((_, j) => j !== i));

  // ── save ───────────────────────────────────────────────────────────────────
  let saving = $state(false);
  async function save() {
    if (!writable || !dirty || saving || !from) return;
    const replace = replaceOf(rows);
    if (!replace) {
      toast.error('Fix the marked entries first');
      return;
    }
    saving = true;
    try {
      const r = await command(
        'dictionarySet',
        { dictionaryId, replace, expectedUpdatedAt: from.updatedAt },
        { toast: false },
      );
      takeBase({ rows: rowsOf(r.entries), updatedAt: r.entriesUpdatedAt }, { force: true });
      toast.success('Saved');
      onsaved?.(r.entries.length);
    } catch (e) {
      if (isAppError(e) && e.code === 'conflict') {
        conflict = true;
        stale = true;
      } else toast.error('Could not save the entries', isAppError(e) ? e.message : undefined);
    } finally {
      saving = false;
    }
  }

  // Unsaved changes: ask before leaving.
  beforeNavigate((nav) => {
    if (dirty && !confirm('Leave without saving your changes to these entries?')) nav.cancel();
  });
  $effect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  });

  function onkeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && writable) {
      e.preventDefault();
      void save();
    }
  }

  const lines = (t: string) => Math.min(12, Math.max(1, t.split('\n').length));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex flex-col gap-3" data-entries-editor={dictionaryId} {onkeydown}>
  {#if loadFailed}
    <p class="flex items-center gap-2 text-sm text-danger">
      <TriangleAlert size={15} /> Couldn't load the entries.
      <Button size="sm" variant="ghost" onclick={() => fetchVersion++}>Try again</Button>
    </p>
  {:else if !from}
    <Skeleton lines={4} height="2.25rem" />
  {:else}
    <div class="flex flex-wrap items-center gap-2">
      <label class="relative min-w-48 flex-1">
        <span class="sr-only">Filter by key</span>
        <Search
          size={14}
          class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle"
        />
        <input
          type="search"
          bind:value={query}
          placeholder="Filter by key"
          data-search
          class="h-8 w-full rounded-md border border-line bg-surface pr-2.5 pl-8 text-sm focus:border-accent focus:outline-none"
        />
      </label>
      <span class="text-xs text-muted" data-entry-count
        >{rows.length}
        {rows.length === 1 ? 'entry' : 'entries'}{q ? ` · ${visible.length} shown` : ''}</span
      >
      {#if writable}
        <span class="ml-auto flex items-center gap-2">
          <span title={full ? `At most ${DICTIONARY_ENTRIES_MAX} entries` : undefined}>
            <Button icon={Plus} disabled={full} onclick={add}>Add entry</Button>
          </span>
          {#if dirty}
            <Button variant="ghost" icon={RotateCcw} disabled={saving} onclick={discard}
              >Discard</Button
            >
          {/if}
          <Button
            variant="primary"
            icon={Save}
            disabled={!dirty || invalid}
            loading={saving}
            onclick={save}
            title={invalid ? 'Fix the marked entries first' : undefined}>Save</Button
          >
        </span>
      {/if}
    </div>

    {#if stale}
      <div
        role="alert"
        class="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
        data-entries-conflict
      >
        <TriangleAlert size={15} class="shrink-0" />
        <span class="min-w-0 flex-1">
          {conflict
            ? 'Not saved: these entries were changed elsewhere since you opened them. Reload to see them (your changes here are dropped).'
            : 'These entries were changed elsewhere while you were editing. Reload to see them (your changes here are dropped).'}
        </span>
        <Button size="sm" variant="secondary" icon={RotateCcw} onclick={reload}>Reload</Button>
      </div>
    {/if}

    {#if !rows.length}
      <p
        class="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted"
      >
        {writable ? 'No entries yet. Add one: a key, and a text or JSON value.' : 'No entries yet.'}
      </p>
    {:else if !visible.length}
      <p class="text-sm text-muted">No key matches “{query.trim()}”.</p>
    {:else}
      <ol class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
        {#each visible as { r, i } (r.rid)}
          {@const kErr = keyErrors[i]}
          {@const vErr = valueErrors[i]}
          <li
            class="grid grid-cols-1 gap-2 px-3 py-2.5 md:grid-cols-[minmax(10rem,16rem)_1fr_auto] md:items-start"
            data-entry={r.key}
            data-entry-row={i}
          >
            {#if writable}
              <div class="flex flex-col gap-1">
                <input
                  value={r.key}
                  use:focusKey={r.rid}
                  oninput={(e) => setKey(i, e.currentTarget.value)}
                  placeholder="KEY_NAME"
                  aria-label="Key"
                  aria-invalid={kErr ? true : undefined}
                  spellcheck="false"
                  autocomplete="off"
                  maxlength={128}
                  class="h-8 w-full rounded-md border bg-surface px-2 font-mono text-sm focus:outline-none {kErr
                    ? 'border-danger'
                    : 'border-line focus:border-accent'}"
                />
                {#if kErr}
                  <p class="text-xs text-danger" data-key-error>{kErr}</p>
                {/if}
              </div>
              <div class="flex min-w-0 flex-col gap-1">
                <div
                  class="inline-flex w-fit rounded-md border border-line p-0.5 text-xs"
                  role="radiogroup"
                  aria-label="Value type"
                >
                  {#each [['text', 'Text'], ['json', 'JSON']] as [t, label] (t)}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={r.type === t}
                      data-type={t}
                      class="rounded px-2 py-0.5 {r.type === t
                        ? 'bg-surface-3 font-medium text-text'
                        : 'text-muted hover:text-text'}"
                      onclick={() => setType(i, t as EntryType)}>{label}</button
                    >
                  {/each}
                </div>
                <textarea
                  value={r.text}
                  oninput={(e) => setText(i, e.currentTarget.value)}
                  rows={lines(r.text)}
                  aria-label="Value of {r.key || 'new entry'}"
                  aria-invalid={vErr ? true : undefined}
                  spellcheck={r.type === 'text'}
                  placeholder={r.type === 'json'
                    ? '{ "a": 1 }  ·  42  ·  true  ·  [1, 2]'
                    : 'Value'}
                  class="w-full resize-y rounded-md border bg-surface px-2 py-1.5 text-sm focus:outline-none {r.type ===
                  'json'
                    ? 'font-mono'
                    : ''} {vErr ? 'border-danger' : 'border-line focus:border-accent'}"></textarea>
                {#if vErr}<p class="text-xs text-danger" data-json-error>{vErr}</p>{/if}
              </div>
              <div class="flex items-center gap-0.5 md:pt-0.5">
                <IconButton
                  icon={ArrowUp}
                  size="sm"
                  label="Move up"
                  disabled={i === 0}
                  onclick={() => move(i, -1)}
                />
                <IconButton
                  icon={ArrowDown}
                  size="sm"
                  label="Move down"
                  disabled={i === rows.length - 1}
                  onclick={() => move(i, 1)}
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  label="Delete {r.key || 'entry'}"
                  class="hover:text-danger"
                  onclick={() => remove(i)}
                />
              </div>
            {:else}
              <code class="font-mono text-sm break-all" data-entry-key>{r.key}</code>
              <div class="flex min-w-0 items-start gap-2">
                <span
                  class="mt-0.5 shrink-0 rounded border border-line px-1.5 text-[10px] font-medium text-muted uppercase"
                  >{r.type === 'json' ? 'JSON' : 'Text'}</span
                >
                <pre
                  class="min-w-0 flex-1 overflow-x-auto text-sm whitespace-pre-wrap {r.type ===
                  'json'
                    ? 'font-mono'
                    : 'font-sans'}"
                  data-entry-value>{r.text}</pre>
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</div>
