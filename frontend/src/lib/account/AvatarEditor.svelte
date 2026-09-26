<!--
  Profile picture — upload, crop (AvatarCropDialog), then uploads a 256px WebP
  and calls profileUpdate. `onsaved` gets the new Storage path.
-->
<script lang="ts">
  import { Camera, Trash2 } from 'lucide-svelte';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { person } from '$lib/people/person';
  import { Avatar, Button, toast } from '$lib/ui';
  import AvatarCropDialog from './AvatarCropDialog.svelte';
  import { uploadAvatar } from './avatar';

  interface Props {
    size?: number;
    onsaved?: (path: string | null) => void;
  }
  let { size = 72, onsaved }: Props = $props();

  const me = $derived(person(auth.uid));
  const name = $derived(auth.profile?.name ?? auth.user?.displayName ?? '');
  let cropper: ReturnType<typeof AvatarCropDialog> | undefined = $state();
  let removing = $state(false);

  async function save(blob: Blob) {
    if (!auth.uid) return;
    const path = await uploadAvatar(auth.uid, blob);
    await command('profileUpdate', { avatarPath: path }, { toast: 'Could not save your picture' });
    toast.success('Picture updated');
    onsaved?.(path);
  }

  async function remove() {
    removing = true;
    try {
      await command(
        'profileUpdate',
        { avatarPath: null },
        { toast: 'Could not remove your picture' },
      );
      onsaved?.(null);
    } catch {
      /* toasted */
    } finally {
      removing = false;
    }
  }
</script>

<div class="flex items-center gap-4">
  <Avatar src={$me.person?.avatarUrl} {name} seed={auth.uid ?? ''} {size} decorative />
  <div class="flex flex-wrap gap-2">
    <Button icon={Camera} onclick={() => cropper?.pick()}>
      {auth.profile?.avatarPath ? 'Change picture' : 'Upload a picture'}
    </Button>
    {#if auth.profile?.avatarPath}
      <Button variant="ghost" icon={Trash2} loading={removing} onclick={remove}>Remove</Button>
    {/if}
  </div>
</div>

<AvatarCropDialog bind:this={cropper} onsave={save} />
