<!--
  One name — or a path — typed: New file, New folder, Rename (memory.html §F).
  '/' separates folders, created as needed: "drafts/notes.md" typed in docs is
  docs/drafts/notes.md, and a leading '/' starts from the top. So a rename can
  move too. The checks are the server's (tree.typedPathProblem, placeProblem);
  the parent runs the command with the resolved full path and says whether to
  close.
-->
<script lang="ts">
  import { CornerDownRight } from 'lucide-svelte';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import {
    memoryParentPath,
    placeProblem,
    resolveTypedPath,
    typedPathProblem,
    type Node,
  } from './tree';

  interface Props {
    open: boolean;
    title: string;
    action: string;
    initial?: string;
    /** The folder a bare name lands in ('' = the top level). */
    folder: string;
    /** Every node of the memory (a clash is caught before the round trip). */
    nodes: readonly Node[];
    /** The node being renamed (null for a new one). */
    node?: Node | null;
    onsubmit: (path: string) => Promise<boolean>;
  }
  let {
    open = $bindable(false),
    title,
    action,
    initial = '',
    folder,
    nodes,
    node = null,
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

  const target = $derived(resolveTypedPath(name, folder));
  const problem = $derived(
    typedPathProblem(name, folder) ?? (target ? placeProblem(nodes, target, node) : null),
  );
  /** Say where it goes once that is not simply "here, with this name". */
  const elsewhere = $derived(!!target && memoryParentPath(target) !== folder);
  const unchanged = $derived(!!node && target === node.path);

  async function submit() {
    touched = true;
    if (problem || busy || !target) return;
    if (unchanged) {
      open = false;
      return;
    }
    busy = true;
    try {
      if (await onsubmit(target)) open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  {title}
  size="sm"
  description={`In ${folder || 'the top level'} · use / for folders`}
>
  <form id="memory-name" onsubmit={(e) => (e.preventDefault(), submit())}>
    <Input
      label="Name or path"
      bind:value={name}
      bind:ref={input}
      maxlength={1024}
      autocomplete="off"
      spellcheck={false}
      error={touched ? (problem ?? undefined) : undefined}
      oninput={() => (touched = true)}
    />
    {#if target && elsewhere && !problem}
      <p class="mt-2 flex items-center gap-1.5 text-xs text-muted" data-resolved-path>
        <CornerDownRight size={13} class="shrink-0" aria-hidden="true" />
        <span class="truncate"
          >{node ? 'Moves to' : 'Goes in'}
          <span class="font-medium text-text">/{target}</span></span
        >
      </p>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="memory-name" loading={busy} disabled={!!problem}
      >{action}</Button
    >
  {/snippet}
</Dialog>
