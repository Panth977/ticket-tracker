<!-- Mounted once by the root layout; shows toast.* messages (slide + fade in, collapse out). -->
<script lang="ts">
  import { fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { CircleAlert, CircleCheck, Info, X } from 'lucide-svelte';
  import { toast } from './toast.svelte';
  import { motion } from './motion';
</script>

<div
  class="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 p-4 sm:items-end"
  aria-live="polite"
  aria-relevant="additions"
>
  {#each toast.items as t (t.id)}
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      animate:flip={{ duration: motion(160) }}
      in:fly={{ y: 12, duration: motion(180) }}
      out:fly={{ x: 24, duration: motion(140) }}
      class="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border bg-surface p-3 text-sm shadow-pop
        {t.kind === 'error' && t.duration === 0 ? 'border-danger/40' : 'border-line'}"
    >
      {#if t.kind === 'error'}<CircleAlert
          size={18}
          class="mt-px shrink-0 text-danger"
          aria-hidden="true"
        />
      {:else if t.kind === 'success'}<CircleCheck
          size={18}
          class="mt-px shrink-0 text-success"
          aria-hidden="true"
        />
      {:else}<Info size={18} class="mt-px shrink-0 text-accent" aria-hidden="true" />{/if}
      <div class="min-w-0 flex-1">
        <p class="font-medium break-words">{t.message}</p>
        {#if t.detail}<p class="mt-0.5 text-muted break-words">{t.detail}</p>{/if}
        {#if t.actions?.length}
          <div class="mt-2 flex gap-3">
            {#each t.actions as a (a.label)}
              <button
                type="button"
                class="tm-press text-sm font-medium hover:underline {a.tone === 'muted'
                  ? 'text-muted'
                  : 'text-accent'}"
                onclick={() => {
                  a.run();
                  toast.dismiss(t.id);
                }}>{a.label}</button
              >
            {/each}
          </div>
        {/if}
      </div>
      {#if t.action}
        <button
          type="button"
          class="tm-press shrink-0 text-sm font-medium text-accent hover:underline"
          onclick={() => {
            t.action?.run();
            toast.dismiss(t.id);
          }}>{t.action.label}</button
        >
      {/if}
      <button
        type="button"
        aria-label="Dismiss"
        class="shrink-0 text-subtle hover:text-text"
        onclick={() => {
          t.ondismiss?.();
          toast.dismiss(t.id);
        }}
      >
        <X size={16} />
      </button>
    </div>
  {/each}
</div>
