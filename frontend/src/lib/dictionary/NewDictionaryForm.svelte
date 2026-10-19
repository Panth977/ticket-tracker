<!--
  + New dictionary (dictionary.html): a name, a line about it, its owner and an
  indicator → dictionaryCreate → the (empty) dictionary, ready for its first entry.
-->
<script lang="ts">
  import OwnerSelect from '$lib/orgs/OwnerSelect.svelte';
  import { ownerOf } from '$lib/orgs/store';
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import {
    DICTIONARY_DESCRIPTION_MAX,
    DICTIONARY_NAME_MAX,
    DICTIONARY_DEFAULT_INDICATOR,
    type Indicator,
  } from '@tm/shared';
  import IndicatorField from '$lib/ui/IndicatorField.svelte';
  import { command } from '$lib/api';
  import StorageField, { storageInput, type StorageChoice } from '$lib/drive/StorageField.svelte';
  import { driveState } from '$lib/drive/drive.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import CreatePage from '$lib/ui/CreatePage.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Textarea from '$lib/ui/Textarea.svelte';

  let { owner: initialOwner = '' }: { owner?: string } = $props();
  /** A page opens once: the form starts fresh (the reset below runs once). */
  let open = $state(true);

  let name = $state('');
  let description = $state('');
  /** null = not picked yet: 📖. */
  let picked = $state<Indicator | null>(null);
  const indicator = $derived(picked ?? DICTIONARY_DEFAULT_INDICATOR);
  let busy = $state(false);
  let owner = $state('');
  /** bucket.html §L5: this app, or a folder of Google Drive (its entries sealed). */
  let storage = $state<StorageChoice>({ kind: 'managed' });
  const storageOk = $derived(storage.kind !== 'drive' || !!driveState.status?.connected);

  $effect(() => {
    if (open) {
      owner = initialOwner;
      name = '';
      description = '';
      picked = null;
    }
  });

  async function create() {
    const n = name.trim();
    if (!n || busy || !storageOk) return;
    busy = true;
    try {
      const { dictionaryId } = await command(
        'dictionaryCreate',
        {
          name: n,
          description: description.trim() || null,
          indicator,
          ...(ownerOf(owner) ? { owner: ownerOf(owner) } : {}),
          ...(storage.kind === 'drive' ? { storage: storageInput(storage)! } : {}),
        },
        { toast: 'Could not create the dictionary' },
      );
      open = false;
      await goto(routes.dictionary(dictionaryId));
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<CreatePage
  title="New dictionary"
  description="Named keys with text or JSON values — settings, limits, URLs. Boards, artifacts and agents can use it; orchestrators hand its env-style keys to agents as environment."
>
  <form
    id="new-dictionary"
    class="flex flex-col gap-4"
    onsubmit={(e) => (e.preventDefault(), create())}
  >
    <Input
      label="Name"
      bind:value={name}
      maxlength={DICTIONARY_NAME_MAX}
      required
      placeholder="Deploy settings"
      autocomplete="off"
    />
    <Textarea
      label="Description"
      bind:value={description}
      maxlength={DICTIONARY_DESCRIPTION_MAX}
      rows={2}
      placeholder="What it is for (optional)"
    />
    <OwnerSelect bind:value={owner} />
    <StorageField
      bind:value={storage}
      name={name.trim() || 'Dictionary'}
      label="Where it lives"
      managedHint="Kept by this app"
      driveHint="A folder in your Drive; its entries sealed with your recovery key"
    />
    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium">Indicator</span>
      <IndicatorField
        value={indicator}
        seed={name}
        label="Dictionary indicator"
        onchange={(i) => (picked = i)}
      />
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => history.back()}>Cancel</Button>
    <Button
      variant="primary"
      type="submit"
      form="new-dictionary"
      disabled={!name.trim() || !storageOk}
      loading={busy}>Create</Button
    >
  {/snippet}
</CreatePage>
