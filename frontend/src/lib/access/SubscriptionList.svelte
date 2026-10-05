<!--
  SUBSCRIPTIONS — what this entity uses, and with which permissions
  (lib/access/relations.ts). Each row: mark · name · kind · permission
  chips · Edit · Remove; then Add, which opens the two-step SubscribeDialog.
  What the viewer may not do is disabled with the reason as its tooltip —
  the server still decides.
-->
<script lang="ts">
  import { Pencil, Plus, Trash2 } from 'lucide-svelte';
  import Button from '$lib/ui/Button.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import EntityLabel from './EntityLabel.svelte';
  import RemoveConfirm from './RemoveConfirm.svelte';
  import SubscribeDialog from './SubscribeDialog.svelte';
  import type { Candidate, Editing, SubscriptionRow } from './entities';
  import type { Allowed, Perms } from './relations';

  interface Props {
    rows: SubscriptionRow[];
    candidates: Candidate[];
    /** true, or why Add is disabled. */
    canAdd: Allowed;
    loading?: boolean;
    /** Shown when there are no rows. */
    empty: string;
    /** The Add dialog's title. */
    addTitle?: string;
    /** The Add dialog's text when there is nothing to pick. */
    nothingToAdd?: string;
    /** Show each row's kind (lists that mix kinds). */
    showKind?: boolean;
    /** What Remove asks; null = remove at once (a draft, like the workspace form). */
    removeMessage?: ((r: SubscriptionRow) => string) | null;
    onsave: (c: Candidate, perms: Perms, isNew: boolean) => Promise<boolean>;
    onremove: (r: SubscriptionRow) => Promise<boolean>;
    /** data-subscriptions value, for tests. */
    name?: string;
  }
  let {
    rows,
    candidates,
    canAdd,
    loading = false,
    empty,
    addTitle = 'Add',
    nothingToAdd,
    showKind = false,
    removeMessage = () => 'It loses this access at once.',
    onsave,
    onremove,
    name = '',
  }: Props = $props();

  let dialogOpen = $state(false);
  let editing = $state<Editing | null>(null);
  let removing = $state<SubscriptionRow | null>(null);
  let confirmOpen = $state(false);
  let busy = $state<string | null>(null);

  const keyOf = (r: { entity: { kind: string; id: string } }) => `${r.entity.kind}:${r.entity.id}`;

  function add() {
    editing = null;
    dialogOpen = true;
  }
  function edit(r: SubscriptionRow) {
    editing = r;
    dialogOpen = true;
  }
  async function remove(r: SubscriptionRow) {
    if (removeMessage) {
      removing = r;
      confirmOpen = true;
      return;
    }
    busy = keyOf(r);
    await onremove(r);
    busy = null;
  }
  async function confirmRemove() {
    if (!removing) return false;
    busy = keyOf(removing);
    const ok = await onremove(removing);
    busy = null;
    return ok;
  }
</script>

<div class="flex flex-col gap-3" data-subscriptions={name}>
  {#if loading}
    <Skeleton lines={2} height="2.5rem" />
  {:else if rows.length}
    <ul class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
      {#each rows as r (keyOf(r))}
        {@const chips = r.relation.chips(r.perms, { stages: r.entity.stages })}
        <li
          class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm"
          data-subscription={keyOf(r)}
        >
          <EntityLabel entity={r.entity} {showKind} link class="min-w-0 flex-1 basis-48" />
          {#if chips.length}
            <span class="flex flex-wrap gap-1" data-chips>
              {#each chips as c (c)}
                <span
                  class="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium"
                  >{c}</span
                >
              {/each}
            </span>
          {/if}
          <span class="ml-auto flex items-center gap-1">
            {#if r.relation.perms.length}
              <span title={r.edit === true ? undefined : r.edit}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Pencil}
                  disabled={r.edit !== true || busy === keyOf(r)}
                  aria-label="Edit {r.entity.name ?? 'access'}"
                  onclick={() => edit(r)}>Edit</Button
                >
              </span>
            {/if}
            <span title={r.remove === true ? undefined : r.remove}>
              <Button
                size="sm"
                variant="ghost"
                class="text-danger"
                icon={Trash2}
                disabled={r.remove !== true || busy === keyOf(r)}
                loading={busy === keyOf(r)}
                aria-label="Remove {r.entity.name ?? 'access'}"
                onclick={() => remove(r)}>Remove</Button
              >
            </span>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-sm text-muted" data-empty>{empty}</p>
  {/if}

  <div title={canAdd === true ? undefined : canAdd}>
    <Button icon={Plus} disabled={canAdd !== true} onclick={add}>Add</Button>
  </div>
</div>

<SubscribeDialog
  bind:open={dialogOpen}
  title={editing ? `Edit ${editing.entity.name ?? 'access'}` : addTitle}
  {candidates}
  {editing}
  emptyText={nothingToAdd}
  {onsave}
/>
<RemoveConfirm
  bind:open={confirmOpen}
  entity={removing?.entity ?? null}
  message={removing && removeMessage ? removeMessage(removing) : ''}
  onconfirm={confirmRemove}
/>
