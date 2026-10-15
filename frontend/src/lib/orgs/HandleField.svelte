<!--
  Account › Profile › Handle (agents.html §AC): your address, /{handle} — the
  owner part of every URL of what you own. Saved by itself (handleSet).
-->
<script lang="ts">
  import { HANDLE_RE, RESERVED_HANDLES } from '@tm/shared';
  import { command } from '$lib/api';
  import { Button, Input, toast } from '$lib/ui';

  let { current }: { current: string | null | undefined } = $props();
  let value = $derived(current ?? '');
  let busy = $state(false);
  const error = $derived(
    !value || value === current
      ? null
      : RESERVED_HANDLES.has(value)
        ? 'That name is used by the app'
        : HANDLE_RE.test(value)
          ? null
          : '2–39 of a–z, 0–9 and -, not starting or ending with -',
  );
  async function save() {
    if (error || !value || value === current) return;
    busy = true;
    try {
      await command('handleSet', { handle: value }, { toast: 'Could not change it' });
      toast.success(`You are @${value}`);
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex items-end gap-2" data-handle-field>
  <Input label="Handle" hint="Your address: /{value || 'handle'}" bind:value {error} />
  <Button
    variant="secondary"
    loading={busy}
    disabled={!!error || !value || value === current}
    onclick={save}>Save handle</Button
  >
</div>
