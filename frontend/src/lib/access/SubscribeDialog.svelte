<!--
  The ONE way to give something access to something else (lib/access):

    step 1  every candidate, searchable, grouped by kind when there are
            several — each with its mark, and a reason when it cannot be
            chosen ("You are not an admin there")
    step 2  the relation's permissions as checkboxes, with a line each; the
            implications hold (Write ticks Read, unticking View unticks the
            rest); an agent made a commenter also gets its stage restriction
            → Add

  Editing opens straight at step 2 with the current permissions → Save.
  A relation with no permissions (a workspace) adds on the pick.
-->
<script lang="ts">
  import { ArrowLeft, Search } from 'lucide-svelte';
  import StageGrantEditor from '$lib/board/StageGrantEditor.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import EntityLabel from './EntityLabel.svelte';
  import type { Candidate, Editing } from './entities';
  import { KIND_LABEL, toggle, type EntityKind, type Perms } from './relations';

  interface Props {
    open: boolean;
    /** "Add a memory", "Add to a board or artifact"… */
    title: string;
    candidates: Candidate[];
    /** Set = edit this one (step 2 at once). */
    editing?: Editing | null;
    /** Shown when there is nothing to pick. */
    emptyText?: string;
    /** Resolves true when it worked (the dialog closes), false to stay. */
    onsave: (c: Candidate, perms: Perms, isNew: boolean) => Promise<boolean>;
  }
  let {
    open = $bindable(false),
    title,
    candidates,
    editing = null,
    emptyText = 'Nothing to add.',
    onsave,
  }: Props = $props();

  let picked = $state<Candidate | null>(null);
  let perms = $state<Perms>({ checks: [] });
  let q = $state('');
  let busy = $state(false);

  // Fresh each time it opens.
  $effect(() => {
    if (!open) return;
    q = '';
    busy = false;
    if (editing) {
      picked = editing;
      perms = { ...editing.perms, checks: [...editing.perms.checks] };
    } else {
      picked = null;
      perms = { checks: [] };
    }
  });

  const ORDER: EntityKind[] = ['board', 'artifact', 'memory', 'agent'];
  const filtered = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    return candidates.filter(
      (c) =>
        !needle ||
        (c.entity.name ?? '').toLowerCase().includes(needle) ||
        (c.entity.key ?? '').toLowerCase().includes(needle),
    );
  });
  const groups = $derived(
    ORDER.map((kind) => ({ kind, items: filtered.filter((c) => c.entity.kind === kind) })).filter(
      (g) => g.items.length,
    ),
  );
  const grouped = $derived(new Set(candidates.map((c) => c.entity.kind)).size > 1);

  async function choose(c: Candidate) {
    if (c.disabled) return;
    if (!c.relation.perms.length) {
      busy = true;
      const ok = await onsave(c, { checks: [] }, true);
      busy = false;
      if (ok) open = false;
      return;
    }
    picked = c;
    perms = {
      ...c.relation.initial,
      checks: c.relation.initial.checks.filter((k: string) => !c.locks?.[k]),
    };
  }

  function tick(key: string, on: boolean) {
    if (!picked) return;
    perms = { ...perms, checks: toggle(picked.relation.perms, perms.checks, key, on) };
  }

  const value = $derived(picked ? picked.relation.fromPerms(perms) : null);
  const showStages = $derived(
    !!picked?.relation.stageGrant &&
      (value as { role?: string } | null)?.role === 'commenter' &&
      !!picked?.entity.stages,
  );

  async function submit() {
    if (!picked || value == null || busy) return;
    busy = true;
    const ok = await onsave(picked, perms, !editing);
    busy = false;
    if (ok) open = false;
  }
</script>

<Dialog bind:open {title} size="md">
  {#if !picked}
    <div class="flex flex-col gap-3" data-subscribe-step="1">
      {#if candidates.length > 6}
        <label class="relative block">
          <span class="sr-only">Search</span>
          <Search
            size={14}
            class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="search"
            bind:value={q}
            placeholder="Search"
            autofocus
            class="h-9 w-full rounded-md border border-line bg-bg pr-2.5 pl-8 text-sm outline-none focus:border-accent"
          />
        </label>
      {/if}
      {#if !candidates.length}
        <p class="text-sm text-muted">{emptyText}</p>
      {:else if !filtered.length}
        <p class="text-sm text-muted">Nothing matches “{q}”.</p>
      {:else}
        <div class="flex max-h-[50dvh] flex-col gap-3 overflow-y-auto">
          {#each groups as g (g.kind)}
            <section class="flex flex-col gap-1" aria-label={KIND_LABEL[g.kind]}>
              {#if grouped}
                <h3 class="px-1 text-xs font-medium tracking-wide text-muted uppercase">
                  {KIND_LABEL[g.kind]}s
                </h3>
              {/if}
              <ul class="flex flex-col divide-y divide-line rounded-lg border border-line">
                {#each g.items as c (c.entity.kind + c.entity.id)}
                  <li>
                    <button
                      type="button"
                      class="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                      disabled={!!c.disabled || busy}
                      title={c.disabled}
                      data-candidate="{c.entity.kind}:{c.entity.id}"
                      onclick={() => choose(c)}
                    >
                      <EntityLabel entity={c.entity} class="w-full" />
                      {#if c.disabled}<span class="text-xs text-muted">{c.disabled}</span>{/if}
                    </button>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-4" data-subscribe-step="2">
      <div class="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <EntityLabel entity={picked.entity} showKind class="flex-1" />
      </div>
      <fieldset class="flex flex-col gap-2.5">
        <legend class="mb-1 text-sm font-medium">Permissions</legend>
        {#each picked.relation.perms as p (p.key)}
          {@const lock = picked.locks?.[p.key]}
          <Checkbox
            checked={perms.checks.includes(p.key)}
            disabled={!!lock || busy}
            label={p.label}
            data-perm={p.key}
            description={lock ? `${p.hint}. ${lock}.` : p.hint}
            onchange={(e) => tick(p.key, (e.currentTarget as HTMLInputElement).checked)}
          />
        {/each}
      </fieldset>
      {#if showStages && picked.entity.stages}
        <div class="flex flex-col gap-1.5" data-stage-grant>
          <span class="text-sm font-medium">Stage restriction</span>
          <StageGrantEditor
            stages={picked.entity.stages}
            grant={perms.stageGrant ?? null}
            label="Stages it may move tickets between"
            onchange={(g) => (perms = { ...perms, stageGrant: g })}
          />
        </div>
      {/if}
      {#if value == null}
        <p class="text-xs text-muted">Tick at least one permission.</p>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    {#if picked && !editing}
      <Button variant="ghost" icon={ArrowLeft} disabled={busy} onclick={() => (picked = null)}
        >Back</Button
      >
    {:else}
      <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    {/if}
    {#if picked}
      <Button variant="primary" loading={busy} disabled={value == null} onclick={submit}
        >{editing ? 'Save' : 'Add'}</Button
      >
    {/if}
  {/snippet}
</Dialog>
