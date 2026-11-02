<!-- Beside the editor: where the backend answers, what it serves, what it logged. -->
<script lang="ts">
  import { Power, RefreshCw } from 'lucide-svelte';
  import type { ArtifactBackendLog } from '@tm/shared';
  import { command } from '$lib/api';
  import Button from '$lib/ui/Button.svelte';
  import { toast } from '$lib/ui/toast.svelte';

  let {
    artifactId,
    url,
    live,
    routes,
    events,
    cpuMs,
    onoff,
  }: {
    artifactId: string;
    url: string | null;
    live: boolean;
    routes: string[];
    events: string[];
    cpuMs: number | null;
    onoff: () => void;
  } = $props();

  let logs = $state<ArtifactBackendLog[]>([]);
  let running = $state(false);

  async function refresh() {
    try {
      const r = await command('artifactBackendLogs', { artifactId }, {});
      logs = r.entries.slice(-100).reverse();
      running = r.running;
    } catch {
      /* the worker is away: the button stays */
    }
  }

  async function turnOff() {
    await command('artifactBackendDisable', { artifactId }, { toast: 'Could not turn it off' });
    toast.success('Backend off', 'Its routes are down.');
    onoff();
  }
</script>

<aside class="hidden w-72 shrink-0 flex-col overflow-auto border-l border-line p-3 text-sm md:flex">
  {#if live}
    <p class="break-all text-xs" data-backend-url>{url}</p>
    <div class="mt-2"><Button size="sm" icon={Power} onclick={() => turnOff()}>Turn off</Button></div>
  {:else}
    <p class="text-muted">Not live yet</p>
  {/if}
  <h3 class="mt-4 font-medium">Routes</h3>
  {#if routes.length}
    <ul class="mt-1 space-y-0.5 font-mono text-xs" data-backend-routes>
      {#each routes as r (r)}<li class="truncate">{r}</li>{/each}
    </ul>
  {:else}
    <p class="mt-1 text-muted">Check the backend to find them.</p>
  {/if}
  {#if events.length}
    <h3 class="mt-4 font-medium">Events</h3>
    <ul class="mt-1 space-y-0.5 font-mono text-xs">
      {#each events as e (e)}<li class="truncate">{e}</li>{/each}
    </ul>
  {/if}
  {#if cpuMs !== null}<p class="mt-4 text-muted">Last build: {cpuMs} ms of CPU</p>{/if}
  <div class="mt-4 flex items-center justify-between">
    <h3 class="font-medium">Logs{running ? ' · running' : ''}</h3>
    <Button size="sm" icon={RefreshCw} onclick={() => refresh()}>Refresh</Button>
  </div>
  <ul class="mt-1 space-y-1 font-mono text-xs">
    {#each logs as l, i (i)}
      <li class="break-words"><span class="text-muted">{l.kind}</span> {l.text}</li>
    {/each}
  </ul>
</aside>
