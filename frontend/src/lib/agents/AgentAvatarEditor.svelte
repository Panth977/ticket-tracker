<!--
  An agent's face (agents.html §B): a picture — uploaded and cropped like your
  own, to users/{me}/agents/{agentId}/avatar/{millis}.webp — or a prebuilt icon
  (brand mark / generic glyph) on the agent's colour, else its initials.
  Precedence: picture > icon > initials. Each choice saves at once through
  agentUpdate { avatarPath } / { icon }; picking an icon leaves the picture as
  it is, "Remove picture" reveals the icon underneath.
-->
<script lang="ts">
  import { Camera, Trash2 } from 'lucide-svelte';
  import { paths, type AgentIconId } from '@tm/shared';
  import { command } from '$lib/api';
  import AvatarCropDialog from '$lib/account/AvatarCropDialog.svelte';
  import { uploadAgentAvatar } from '$lib/account/avatar';
  import { auth } from '$lib/firebase/auth.svelte';
  import { avatarUrl } from '$lib/people/person';
  import { Avatar, Button, toast } from '$lib/ui';
  import AgentIconPicker from './AgentIconPicker.svelte';
  import { agentIconLabel } from './icons';

  interface Props {
    agentId: string;
    name: string;
    avatarPath: string | null;
    icon?: AgentIconId | null;
    disabled?: boolean;
    size?: number;
  }
  let { agentId, name, avatarPath, icon = null, disabled = false, size = 72 }: Props = $props();

  let url = $state<string | null>(null);
  $effect(() => {
    const p = avatarPath;
    url = null;
    let live = true;
    void avatarUrl(p).then((u) => {
      if (live) url = u;
    });
    return () => {
      live = false;
    };
  });

  let cropper: ReturnType<typeof AvatarCropDialog> | undefined = $state();
  let removing = $state(false);
  let savingIcon = $state(false);

  async function save(blob: Blob) {
    if (!auth.uid) return;
    const path = await uploadAgentAvatar(auth.uid, agentId, blob);
    await command(
      'agentUpdate',
      { agentId, avatarPath: path },
      { toast: 'Could not save the picture' },
    );
    toast.success('Picture updated');
  }

  async function remove() {
    removing = true;
    try {
      await command(
        'agentUpdate',
        { agentId, avatarPath: null },
        { toast: 'Could not remove the picture' },
      );
    } catch {
      /* toasted */
    } finally {
      removing = false;
    }
  }

  async function pickIcon(id: AgentIconId | null) {
    if (id === icon) return;
    savingIcon = true;
    try {
      await command(
        'agentUpdate',
        { agentId, icon: id },
        {
          optimistic: { path: paths.agent(agentId), patch: { icon: id } },
          toast: 'Could not save the icon',
        },
      );
    } catch {
      /* toasted */
    } finally {
      savingIcon = false;
    }
  }

  const status = $derived(
    avatarPath
      ? icon
        ? `Picture (the ${agentIconLabel(icon)} icon shows if you remove it)`
        : 'Picture'
      : icon
        ? `${agentIconLabel(icon)} icon`
        : 'Initials',
  );
</script>

<div class="flex items-center gap-4">
  <Avatar src={url} {icon} {name} seed={agentId} {size} decorative />
  <div class="flex min-w-0 flex-col gap-2">
    {#if !disabled}
      <div class="flex flex-wrap gap-2">
        <AgentIconPicker
          value={icon}
          {name}
          seed={agentId}
          busy={savingIcon}
          label="Icon or picture"
          onpick={pickIcon}
        >
          {#snippet footer()}
            <Button size="sm" icon={Camera} onclick={() => cropper?.pick()}
              >{avatarPath ? 'Change picture' : 'Upload a picture'}</Button
            >
            {#if avatarPath}<Button
                size="sm"
                variant="ghost"
                icon={Trash2}
                loading={removing}
                onclick={remove}>Remove picture</Button
              >{/if}
          {/snippet}
        </AgentIconPicker>
      </div>
    {/if}
    <p class="text-xs text-muted" data-avatar-status>{status}</p>
  </div>
</div>

<AvatarCropDialog bind:this={cropper} title="Crop {name || 'the agent'}’s picture" onsave={save} />
