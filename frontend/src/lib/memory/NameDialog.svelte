<!--
  One name, typed: New file, New folder, Rename (memory.html §F). The checks
  are the same as the server's (tree.nameProblem); the parent runs the command
  and says whether to close.
-->
<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { nameProblem } from './tree';

  interface Props {
    open: boolean;
    title: string;
    action: string;
    initial?: string;
    /** Shown under the title: where it goes. */
    description?: string;
    /** Names already in the folder (a clash is caught before the round trip). */
    taken?: readonly string[];
    onsubmit: (name: string) => Promise<boolean>;
  }
  let {
    open = $bindable(false),
    title,
    action,
    initial = '',
    description,
    taken = [],
    onsubmit,
  }: Props = $props();

  let name = $state('');
  let busy = $state(false);
  let touched = $state(false);
  let input: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (open) {
      name = initial;
      touched = false;
      // Select the stem, not the extension — the usual rename gesture.
      queueMicrotask(() => {
        if (!input) return;
        input.focus();
        const dot = initial.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : initial.length);
      });
    }
  });

  const problem = $derived(
    nameProblem(name) ??
      (name.trim() !== initial && taken.includes(name.trim())
        ? 'Something with that name is already here'
        : null),
  );

  async function submit() {
    touched = true;
    if (problem || busy) return;
    busy = true;
    try {
      if (await onsubmit(name.trim())) open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open {title} size="sm" {description}>
  <form id="memory-name" onsubmit={(e) => (e.preventDefault(), submit())}>
    <Input
      label="Name"
      bind:value={name}
      bind:ref={input}
      maxlength={255}
      autocomplete="off"
      error={touched ? (problem ?? undefined) : undefined}
      oninput={() => (touched = true)}
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="memory-name" loading={busy} disabled={!!problem}
      >{action}</Button
    >
  {/snippet}
</Dialog>
