<!--
  The thin progress bar at the top of the window (agents.html § K › Loaders):
  shown while SvelteKit navigates and while `active` (first load). It creeps
  towards 90 % while busy, then fills and fades when done. Shown only after
  a short delay, so instant navigations don't flash it.
    <TopProgress active={booting} />
-->
<script lang="ts">
  import { navigating } from '$app/state';

  let { active = false }: { active?: boolean } = $props();

  const busy = $derived(active || !!navigating.to);
  let shown = $state(false);
  let finishing = $state(false);
  let run = $state(0);

  $effect(() => {
    if (busy) {
      finishing = false;
      const t = setTimeout(() => {
        run += 1;
        shown = true;
      }, 120);
      return () => clearTimeout(t);
    }
    if (!shown) return;
    finishing = true;
    const t = setTimeout(() => {
      shown = false;
      finishing = false;
    }, 320);
    return () => clearTimeout(t);
  });
</script>

{#if shown}
  <div
    class="pointer-events-none fixed inset-x-0 top-0 z-[80] h-0.5"
    role="progressbar"
    aria-label="Loading"
    aria-busy={!finishing}
  >
    {#key run}
      <div
        class="h-full origin-left bg-accent shadow-[0_0_8px_var(--tm-accent)] {finishing
          ? ''
          : 'tm-progress'}"
        style={finishing
          ? 'transform:scaleX(1);opacity:0;transition:transform 180ms ease-out,opacity 200ms 120ms ease-out'
          : ''}
      ></div>
    {/key}
  </div>
{/if}
