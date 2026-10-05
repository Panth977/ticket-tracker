<!--
  + New memory (memory.html §F): a name, an optional emoji and a line about it
  → memoryCreate → the (empty) memory, ready for its first upload.
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { MEMORY_DESCRIPTION_MAX, MEMORY_NAME_MAX } from '@tm/shared';
  import { command } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Textarea from '$lib/ui/Textarea.svelte';

  let { open = $bindable(false) }: { open: boolean } = $props();

  let name = $state('');
  let icon = $state('');
  let description = $state('');
  let busy = $state(false);

  $effect(() => {
    if (open) {
      name = '';
      icon = '';
      description = '';
    }
  });

  async function create() {
    const n = name.trim();
    if (!n || busy) return;
    busy = true;
    try {
      const { memoryId } = await command(
        'memoryCreate',
        { name: n, description: description.trim() || null, icon: icon.trim() || null },
        { toast: 'Could not create the memory' },
      );
      open = false;
      await goto(routes.memory(memoryId));
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title="New memory"
  size="sm"
  description="A bucket for files you keep: notes, screenshots, videos, builds. Tickets and artifacts can use them without a second upload."
>
  <form
    id="new-memory"
    class="flex flex-col gap-4"
    onsubmit={(e) => (e.preventDefault(), create())}
  >
    <div class="flex gap-3">
      <Input
        label="Emoji"
        bind:value={icon}
        maxlength={8}
        placeholder="🧠"
        autocomplete="off"
        class="w-20"
        inputClass="text-center"
      />
      <Input
        label="Name"
        bind:value={name}
        maxlength={MEMORY_NAME_MAX}
        required
        placeholder="Brand kit"
        autocomplete="off"
        class="flex-1"
      />
    </div>
    <Textarea
      label="Description"
      bind:value={description}
      maxlength={MEMORY_DESCRIPTION_MAX}
      rows={2}
      placeholder="What it is for (optional)"
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="new-memory" disabled={!name.trim()} loading={busy}
      >Create</Button
    >
  {/snippet}
</Dialog>
