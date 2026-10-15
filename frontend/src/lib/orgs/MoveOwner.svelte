<!--
  Danger zone › Move (agents.html §AC, ownerTransfer): give a board, artifact
  or bucket to another owner — you, or an org where you are an owner or
  admin. Its people stay; the new org's members get the org's roles, the old
  org's lose theirs. Its URL moves with it (/{new handle}/…).
-->
<script lang="ts">
  import type { ThingKind } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Button, Select, toast } from '$lib/ui';
  import { myOrgs, ownerOf } from './store';

  let { kind, id, ownerKey }: { kind: ThingKind; id: string; ownerKey: string | null | undefined } =
    $props();
  const orgsQ = $derived(myOrgs(auth.uid));
  const me = $derived(auth.uid ?? '');
  const current = $derived(ownerKey ?? `user:${me}`);
  const options = $derived(
    [
      { value: `user:${me}`, label: 'You' },
      ...[...$orgsQ.data]
        .filter((o) => o.members[me] === 'owner' || o.members[me] === 'admin')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((o) => ({ value: `org:${o.id}`, label: `${o.name} (org)` })),
    ].filter((o) => o.value !== current),
  );
  let to = $state('');
  let busy = $state(false);
  $effect(() => {
    if (!options.some((o) => o.value === to)) to = options[0]?.value ?? '';
  });

  async function move() {
    const target = ownerOf(to);
    if (!target) return;
    busy = true;
    try {
      const r = await command(
        'ownerTransfer',
        { thing: { kind, id }, to: target },
        { toast: 'Could not move it' },
      );
      toast.success(`Moved to @${r.handle}`);
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-wrap items-center gap-3 p-5" data-move-owner>
  <div class="min-w-0 flex-1">
    <h3 class="font-medium">Move to another owner</h3>
    <p class="text-sm text-muted">
      To you, or to an org you run. Its people stay; the org's members join at the org's roles.
    </p>
  </div>
  {#if options.length}
    <Select aria-label="New owner" {options} bind:value={to} />
    <Button variant="secondary" loading={busy} onclick={move}>Move</Button>
  {:else}
    <span class="text-sm text-muted">Create an org first.</span>
  {/if}
</div>
