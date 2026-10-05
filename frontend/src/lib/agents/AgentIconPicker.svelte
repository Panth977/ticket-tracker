<!--
  The icon picker for an agent's avatar (agents.html §B): a button that opens
  a popover with the brand marks, the generic icons and "none (initials)",
  each drawn exactly as the avatar will look: a BRAND mark on its own tile
  (the brand's colours — lib/agents/icons, lib/ui/Avatar), a generic icon and
  the initials on the agent's colour. The 15 brands sit five to a row, so they
  fill three even rows. Optional
  `footer` for the picture actions (upload / remove) so the whole choice lives
  in one place. Fits a 390 px phone: the panel is min(20rem, 100vw - 1rem).

    <AgentIconPicker value={icon} {name} seed={agentId} onpick={(id) => …}>
      {#snippet footer()}<Button …>Upload a picture</Button>{/snippet}
    </AgentIconPicker>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDown, Smile } from 'lucide-svelte';
  import { AGENT_BRAND_ICONS, AGENT_GENERIC_ICONS, type AgentIconId } from '@tm/shared';
  import { Avatar, Button, Popover } from '$lib/ui';

  interface Props {
    value: AgentIconId | null;
    /** For the previews: the agent's name (initials) and colour seed. */
    name: string;
    seed: string;
    onpick: (id: AgentIconId | null) => void;
    disabled?: boolean;
    busy?: boolean;
    label?: string;
    footer?: Snippet;
  }
  let {
    value,
    name,
    seed,
    onpick,
    disabled = false,
    busy = false,
    label = 'Choose an icon',
    footer,
  }: Props = $props();

  let open = $state(false);
  let anchor: HTMLElement | undefined = $state();

  function pick(id: AgentIconId | null) {
    onpick(id);
    open = false;
  }
</script>

<span bind:this={anchor} class="inline-flex">
  <Button
    icon={Smile}
    loading={busy}
    {disabled}
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-haspopup="dialog"
  >
    {label}
    <ChevronDown size={14} class="opacity-60" />
  </Button>
</span>

<Popover bind:open {anchor} label="Agent icon" class="w-[min(20rem,calc(100vw-1rem))] p-3">
  <div class="flex flex-col gap-3" data-agent-icon-picker>
    <section>
      <h3 class="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Brand</h3>
      <div class="grid grid-cols-5 gap-1.5" role="listbox" aria-label="Brand marks">
        {#each AGENT_BRAND_ICONS as i (i.id)}
          <button
            type="button"
            role="option"
            aria-selected={value === i.id}
            title={i.label}
            aria-label={i.label}
            class="grid place-items-center rounded-lg p-1 hover:bg-surface-2 {value === i.id
              ? 'ring-2 ring-accent'
              : ''}"
            onclick={() => pick(i.id)}
          >
            <Avatar icon={i.id} {name} {seed} size={32} decorative />
          </button>
        {/each}
      </div>
    </section>

    <section>
      <h3 class="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Icons</h3>
      <div
        class="grid max-h-56 grid-cols-6 gap-1.5 overflow-y-auto"
        role="listbox"
        aria-label="Icons"
      >
        <button
          type="button"
          role="option"
          aria-selected={value === null}
          title="No icon — initials"
          aria-label="No icon — initials"
          class="grid place-items-center rounded-lg p-1 hover:bg-surface-2 {value === null
            ? 'ring-2 ring-accent'
            : ''}"
          onclick={() => pick(null)}
        >
          <Avatar {name} {seed} size={32} decorative />
        </button>
        {#each AGENT_GENERIC_ICONS as i (i.id)}
          <button
            type="button"
            role="option"
            aria-selected={value === i.id}
            title={i.label}
            aria-label={i.label}
            class="grid place-items-center rounded-lg p-1 hover:bg-surface-2 {value === i.id
              ? 'ring-2 ring-accent'
              : ''}"
            onclick={() => pick(i.id)}
          >
            <Avatar icon={i.id} {name} {seed} size={32} decorative />
          </button>
        {/each}
      </div>
    </section>

    {#if footer}
      <div class="flex flex-wrap gap-2 border-t border-line pt-3">
        {@render footer()}
      </div>
    {/if}
  </div>
</Popover>
