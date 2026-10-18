<!--
  Back from Google's consent page (bucket.html §K1): /integrations/drive/callback
  sends the person to where they started with ?drive=connected|error — say how
  it went, once, wherever that is.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { driveState, takeDriveResult } from './drive.svelte';

  onMount(() => {
    const r = takeDriveResult();
    if (!r) return;
    void driveState.load(true);
    if (r.ok) toast.success('Google Drive connected');
    else toast.error('Google Drive was not connected', r.reason ?? undefined);
  });
</script>
