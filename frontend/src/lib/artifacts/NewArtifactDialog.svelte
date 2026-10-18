<!--
  + New artifact (docs/plan/artifacts.html §F): a name and an optional line
  about it → artifactCreate → its page, which explains how to publish the first
  build. Deliberately tiny: an artifact's substance is the build an agent
  publishes, not anything typed here.
-->
<script lang="ts">
  import OwnerSelect from '$lib/orgs/OwnerSelect.svelte';
  import { ownerOf } from '$lib/orgs/store';
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import {
    ARTIFACT_DESCRIPTION_MAX,
    ARTIFACT_NAME_MAX,
    defaultIndicator,
    type Indicator,
  } from '@tm/shared';
  import IndicatorField from '$lib/ui/IndicatorField.svelte';
  import { command } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Textarea from '$lib/ui/Textarea.svelte';
  import StorageField, { type StorageChoice } from '$lib/drive/StorageField.svelte';
  import { driveState } from '$lib/drive/drive.svelte';
  import { storageFor } from '$lib/drive/storageFor';
  import { toast } from '$lib/ui/toast.svelte';

  let { open = $bindable(false), owner: initialOwner = '' }: { open: boolean; owner?: string } =
    $props();

  let name = $state('');
  let description = $state('');
  /** null = not picked yet: a palette colour that follows the name. */
  let picked = $state<Indicator | null>(null);
  const indicator = $derived(picked ?? defaultIndicator(name.trim() || 'artifact'));
  let busy = $state(false);
  let owner = $state('');
  /** bucket.html §K5: a bucket for its files, made with it — or none. */
  let storage = $state<StorageChoice>({ kind: 'none' });
  const storageOk = $derived(storage.kind !== 'drive' || !!driveState.status?.connected);

  // A fresh form each time it opens.
  $effect(() => {
    if (open) {
      owner = initialOwner;
      name = '';
      description = '';
      picked = null;
      storage = { kind: 'none' };
    }
  });

  async function create() {
    const n = name.trim();
    if (!n || busy || !storageOk) return;
    busy = true;
    try {
      const { artifactId } = await command(
        'artifactCreate',
        {
          name: n,
          description: description.trim() || null,
          indicator,
          ...(ownerOf(owner) ? { owner: ownerOf(owner) } : {}),
        },
        { toast: 'Could not create the artifact' },
      );
      if (storage.kind !== 'none')
        await storageFor(
          storage,
          { artifactId },
          { name: `${n} files`, owner: ownerOf(owner) },
        ).catch((e: Error) => toast.error('Artifact created, but its bucket was not', e.message));
      open = false;
      await goto(routes.artifact(artifactId));
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title="New artifact"
  size="sm"
  description="A small website that lives here: a dashboard, a tracker, a form. You publish its files next."
>
  <form
    id="new-artifact"
    class="flex flex-col gap-4"
    onsubmit={(e) => (e.preventDefault(), create())}
  >
    <Input
      label="Name"
      bind:value={name}
      maxlength={ARTIFACT_NAME_MAX}
      required
      placeholder="Sales dashboard"
      autocomplete="off"
    />
    <Textarea
      label="Description"
      bind:value={description}
      maxlength={ARTIFACT_DESCRIPTION_MAX}
      rows={2}
      placeholder="What it is for (optional)"
    />
    <OwnerSelect bind:value={owner} />
    <StorageField
      bind:value={storage}
      allowNone
      name="{name.trim() || 'Artifact'} files"
      label="A bucket for its files"
      managedHint="A new bucket, kept by this app"
      noneHint="Grant one later"
    />
    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium">Indicator</span>
      <IndicatorField
        value={indicator}
        seed={name}
        label="Artifact indicator"
        onchange={(i) => (picked = i)}
      />
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button
      variant="primary"
      type="submit"
      form="new-artifact"
      disabled={!name.trim() || !storageOk}
      loading={busy}>Create</Button
    >
  {/snippet}
</Dialog>
