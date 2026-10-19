<!--
  The frame of every "New …" screen (a board, a bucket, an artifact, a
  dictionary, an org, an agent): one page of its own, like /new-board — a way
  back, the title, a line about it, the form in a card, the actions under it.
  Creating is a page, never a modal: a page has room (storage, folder picker),
  and Google's Drive picker can open above it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ArrowLeft } from 'lucide-svelte';
  import Button from './Button.svelte';

  interface Props {
    title: string;
    description?: string;
    /** Where "back" goes when there is no history (a link opened in a new tab). */
    fallback?: string;
    children?: Snippet;
    footer?: Snippet;
  }
  let { title, description, fallback = '/', children, footer }: Props = $props();

  export function back(): void {
    if (history.length > 1) history.back();
    else location.assign(fallback);
  }
</script>

<main class="min-h-dvh bg-bg px-4 py-8 sm:py-12">
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
    <div>
      <Button variant="ghost" size="sm" icon={ArrowLeft} onclick={back}>Back</Button>
    </div>
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-semibold">{title}</h1>
      {#if description}<p class="text-sm text-muted">{description}</p>{/if}
    </div>
    <div class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      {@render children?.()}
    </div>
    {#if footer}
      <div class="flex justify-end gap-2">{@render footer()}</div>
    {/if}
  </div>
</main>
