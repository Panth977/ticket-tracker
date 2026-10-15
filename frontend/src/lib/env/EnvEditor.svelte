<!--
  Env: key/value pairs on a board, artifact, bucket, agent or org (shared
  src/env) — mostly read by orchestrators, which hand them to their agents as
  process environment. Plain text, not a place for secrets. Pairs inherited
  from the org are shown, and an own pair with the same key overrides them.
-->
<script lang="ts">
  import { ENV_KEY_RE, ENV_PAIRS_MAX, ENV_VALUE_MAX, type EnvKind } from '@tm/shared';
  import { Plus, Trash2 } from 'lucide-svelte';
  import { command } from '$lib/api';
  import Button from '$lib/ui/Button.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Input from '$lib/ui/Input.svelte';

  let { kind, id, canEdit }: { kind: EnvKind; id: string; canEdit: boolean } = $props();

  type Row = { key: string; value: string };
  let rows = $state<Row[]>([]);
  let inherited = $state<Record<string, string>>({});
  let saved = $state('');
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const snapshot = (r: Row[]) => JSON.stringify(r.filter((x) => x.key || x.value));
  const dirty = $derived(snapshot(rows) !== saved);
  const problems = $derived.by(() => {
    const used = rows.filter((r) => r.key || r.value);
    for (const [i, r] of used.entries()) {
      if (!ENV_KEY_RE.test(r.key)) return `“${r.key || '(empty)'}” is not a valid name`;
      if (used.findIndex((x) => x.key === r.key) !== i) return `“${r.key}” is there twice`;
      if (r.value.length > ENV_VALUE_MAX) return `“${r.key}” is longer than ${ENV_VALUE_MAX}`;
    }
    return used.length > ENV_PAIRS_MAX ? `At most ${ENV_PAIRS_MAX} pairs` : null;
  });

  function take(env: { vars: Record<string, string>; inherited: Record<string, string> }) {
    rows = Object.entries(env.vars)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }));
    inherited = env.inherited;
    saved = snapshot(rows);
  }

  $effect(() => {
    loading = true;
    error = null;
    command('envGet', { target: { kind, id } })
      .then(take)
      .catch((e: Error) => (error = e.message))
      .finally(() => (loading = false));
  });

  async function save() {
    if (problems) return;
    busy = true;
    try {
      const replace = Object.fromEntries(
        rows.filter((r) => r.key || r.value).map((r) => [r.key, r.value]),
      );
      take(await command('envSet', { target: { kind, id }, replace }, { toast: 'Could not save' }));
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col gap-3" data-env-editor>
  {#if loading}
    <p class="text-sm text-muted">Loading…</p>
  {:else if error}
    <p class="text-sm text-danger" role="alert">{error}</p>
  {:else}
    {#if Object.keys(inherited).length}
      <div class="flex flex-col gap-1" data-env-inherited>
        <p class="text-xs font-semibold tracking-wide text-subtle uppercase">From the org</p>
        {#each Object.entries(inherited) as [k, v] (k)}
          <p
            class="font-mono text-sm text-muted"
            class:line-through={rows.some((r) => r.key === k)}
          >
            {k}={v}
          </p>
        {/each}
      </div>
    {/if}
    {#each rows as row, i (i)}
      <div class="flex items-center gap-2" data-env-row>
        <Input
          aria-label="Name"
          placeholder="NAME"
          class="w-56 font-mono"
          bind:value={row.key}
          disabled={!canEdit}
        />
        <Input
          aria-label="Value"
          placeholder="value"
          class="flex-1 font-mono"
          bind:value={row.value}
          disabled={!canEdit}
        />
        {#if canEdit}
          <IconButton
            icon={Trash2}
            label="Remove"
            onclick={() => (rows = rows.filter((_, j) => j !== i))}
          />
        {/if}
      </div>
    {:else}
      <p class="text-sm text-muted">No pairs yet.</p>
    {/each}
    {#if canEdit}
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          icon={Plus}
          onclick={() => (rows = [...rows, { key: '', value: '' }])}>Add</Button
        >
        <Button variant="primary" disabled={!dirty || !!problems} loading={busy} onclick={save}
          >Save env</Button
        >
        {#if problems}<span class="text-sm text-danger">{problems}</span>{/if}
      </div>
    {/if}
    <p class="text-xs text-muted">
      Plain text, not for secrets: everyone who can edit this sees it, and so do its agents.
    </p>
  {/if}
</div>
