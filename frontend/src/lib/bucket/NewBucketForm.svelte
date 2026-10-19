<!--
  + New bucket (bucket.html §F): a name, a line about it, an indicator and
  where its files live (§K: managed, or a folder in my Google Drive)
  → bucketCreate → the (empty) bucket, ready for its first upload.
-->
<script lang="ts">
  import OwnerSelect from '$lib/orgs/OwnerSelect.svelte';
  import { ownerOf } from '$lib/orgs/store';
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import {
    BUCKET_DESCRIPTION_MAX,
    BUCKET_NAME_MAX,
    BUCKET_DEFAULT_INDICATOR,
    type Indicator,
  } from '@tm/shared';
  import IndicatorField from '$lib/ui/IndicatorField.svelte';
  import { command } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import CreatePage from '$lib/ui/CreatePage.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Textarea from '$lib/ui/Textarea.svelte';
  import StorageField, { storageInput, type StorageChoice } from '$lib/drive/StorageField.svelte';
  import { driveState } from '$lib/drive/drive.svelte';

  let { owner: initialOwner = '' }: { owner?: string } = $props();
  /** A page opens once: the form starts fresh (the reset below runs once). */
  let open = $state(true);

  let name = $state('');
  let description = $state('');
  /** null = not picked yet: 🧠. */
  let picked = $state<Indicator | null>(null);
  const indicator = $derived(picked ?? BUCKET_DEFAULT_INDICATOR);
  let busy = $state(false);
  let owner = $state('');
  let storage = $state<StorageChoice>({ kind: 'managed' });
  const storageOk = $derived(storage.kind !== 'drive' || !!driveState.status?.connected);

  $effect(() => {
    if (open) {
      owner = initialOwner;
      name = '';
      description = '';
      picked = null;
      storage = { kind: 'managed' };
    }
  });

  async function create() {
    const n = name.trim();
    if (!n || busy || !storageOk) return;
    busy = true;
    try {
      const st = storageInput(storage);
      const { bucketId } = await command(
        'bucketCreate',
        {
          name: n,
          description: description.trim() || null,
          indicator,
          ...(st && st.kind === 'drive' ? { storage: st } : {}),
          ...(ownerOf(owner) ? { owner: ownerOf(owner) } : {}),
        },
        { toast: 'Could not create the bucket' },
      );
      open = false;
      await goto(routes.bucket(bucketId));
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<CreatePage
  title="New bucket"
  description="A bucket for files you keep: notes, screenshots, videos, builds. Tickets and artifacts can use them without a second upload."
>
  <form
    id="new-bucket"
    class="flex flex-col gap-4"
    onsubmit={(e) => (e.preventDefault(), create())}
  >
    <Input
      label="Name"
      bind:value={name}
      maxlength={BUCKET_NAME_MAX}
      required
      placeholder="Brand kit"
      autocomplete="off"
    />
    <Textarea
      label="Description"
      bind:value={description}
      maxlength={BUCKET_DESCRIPTION_MAX}
      rows={2}
      placeholder="What it is for (optional)"
    />
    <OwnerSelect bind:value={owner} />
    <StorageField bind:value={storage} {name} label="Where its files live" />
    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium">Indicator</span>
      <IndicatorField
        value={indicator}
        seed={name}
        label="Bucket indicator"
        onchange={(i) => (picked = i)}
      />
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => history.back()}>Cancel</Button>
    <Button
      variant="primary"
      type="submit"
      form="new-bucket"
      disabled={!name.trim() || !storageOk}
      loading={busy}>Create</Button
    >
  {/snippet}
</CreatePage>
