<!--
  One Board settings section: heading, body and — when it edits a draft — its
  own Save / Discard bar (each section saves itself).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from '$lib/ui/Button.svelte';

  interface Props {
    title: string;
    description?: string;
    /** Present = this section has a draft with a save bar. */
    dirty?: boolean;
    busy?: boolean;
    readOnly?: boolean;
    onsave?: () => void | Promise<void>;
    onreset?: () => void;
    saveLabel?: string;
    actions?: Snippet;
    children: Snippet;
  }
  let {
    title,
    description,
    dirty,
    busy = false,
    readOnly = false,
    onsave,
    onreset,
    saveLabel = 'Save section',
    actions,
    children,
  }: Props = $props();
</script>

<section class="flex flex-col gap-5">
  <header class="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
    <div>
      <h2 class="text-xl font-semibold">{title}</h2>
      {#if description}<p class="mt-1 max-w-prose text-sm text-muted">{description}</p>{/if}
    </div>
    {#if actions}<div class="flex gap-2">{@render actions()}</div>{/if}
  </header>

  {#if readOnly}
    <p class="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
      Only board admins can change this.
    </p>
  {/if}

  {@render children()}

  {#if onsave && !readOnly}
    <div
      class="sticky bottom-0 -mx-1 flex items-center gap-2 border-t border-line bg-bg/95 px-1 py-3 backdrop-blur"
    >
      {#if dirty}<span class="text-sm text-muted">Unsaved changes</span>{/if}
      <div class="ml-auto flex gap-2">
        <Button variant="ghost" disabled={!dirty || busy} onclick={onreset}>Discard</Button>
        <Button variant="primary" disabled={!dirty} loading={busy} onclick={onsave}
          >{saveLabel}</Button
        >
      </div>
    </div>
  {/if}
</section>
