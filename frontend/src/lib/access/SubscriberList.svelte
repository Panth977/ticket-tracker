<!--
  SUBSCRIBERS — every entity that may use this one, with what it was given,
  and Remove (after a confirmation). Nothing is added or edited here: that
  happens in the subscriber's own Subscriptions. An entity the viewer cannot
  open still shows ("A board you are not on") and can still be removed when
  the viewer has the right.
-->
<script lang="ts">
  import { Trash2 } from 'lucide-svelte';
  import Button from '$lib/ui/Button.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import EntityLabel from './EntityLabel.svelte';
  import RemoveConfirm from './RemoveConfirm.svelte';
  import type { SubscriberRow } from './entities';

  interface Props {
    rows: SubscriberRow[];
    loading?: boolean;
    empty: string;
    /** Show each row's kind (lists that mix kinds). */
    showKind?: boolean;
    removeMessage?: (r: SubscriberRow) => string;
    onremove: (r: SubscriberRow) => Promise<boolean>;
    name?: string;
  }
  let {
    rows,
    loading = false,
    empty,
    showKind = true,
    removeMessage = () => 'It loses this access at once.',
    onremove,
    name = '',
  }: Props = $props();

  let removing = $state<SubscriberRow | null>(null);
  let confirmOpen = $state(false);
  const keyOf = (r: SubscriberRow) => `${r.entity.kind}:${r.entity.id}`;

  function ask(r: SubscriberRow) {
    removing = r;
    confirmOpen = true;
  }
  async function confirm() {
    return removing ? onremove(removing) : false;
  }
</script>

<div class="flex flex-col gap-3" data-subscribers={name}>
  {#if loading}
    <Skeleton lines={2} height="2.5rem" />
  {:else if rows.length}
    <ul class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
      {#each rows as r (keyOf(r))}
        <li
          class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm"
          data-subscriber={keyOf(r)}
        >
          <EntityLabel entity={r.entity} {showKind} link class="min-w-0 flex-1 basis-48" />
          {#if r.chips.length}
            <span class="flex flex-wrap gap-1" data-chips>
              {#each r.chips as c (c)}
                <span
                  class="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium"
                  >{c}</span
                >
              {/each}
            </span>
          {/if}
          <span class="ml-auto" title={r.remove === true ? undefined : r.remove}>
            <Button
              size="sm"
              variant="ghost"
              class="text-danger"
              icon={Trash2}
              disabled={r.remove !== true}
              aria-label="Remove {r.entity.name ?? 'access'}"
              onclick={() => ask(r)}>Remove</Button
            >
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-sm text-muted" data-empty>{empty}</p>
  {/if}
</div>

<RemoveConfirm
  bind:open={confirmOpen}
  entity={removing?.entity ?? null}
  message={removing ? removeMessage(removing) : ''}
  onconfirm={confirm}
/>
