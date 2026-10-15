<!--
  An org's picture (agents.html §AC): uploaded and cropped like your own
  (AvatarCropDialog → a 256px WebP), stored as the org's image indicator at
  indicators/{me}/{fileId}/picture.webp, so every place that draws the org's
  mark (sidebar, owner page, crumbs) shows it. "Colour, icon or emoji" picks
  any other mark; "Remove" goes back to the org's default colour. Each choice
  saves at once through orgUpdate { indicator }.
-->
<script lang="ts">
  import { Camera, Trash2 } from 'lucide-svelte';
  import {
    defaultIndicator,
    indicatorOf,
    paths,
    type Indicator as Mark,
    type Org,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import AvatarCropDialog from '$lib/account/AvatarCropDialog.svelte';
  import { Button, IndicatorField, toast } from '$lib/ui';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { uploadIndicatorImage } from '$lib/ui/indicatorUpload';
  import type { WithId } from '$lib/stores';

  interface Props {
    org: WithId<Org>;
    disabled?: boolean;
  }
  let { org, disabled = false }: Props = $props();

  const mark = $derived(indicatorOf(org, org.id));
  const hasPicture = $derived(mark.kind === 'image');
  let cropper: ReturnType<typeof AvatarCropDialog> | undefined = $state();
  let removing = $state(false);

  async function setMark(indicator: Mark, what: string) {
    await command(
      'orgUpdate',
      { orgId: org.id, indicator },
      {
        optimistic: { path: paths.org(org.id), patch: { indicator } },
        toast: `Could not save the ${what}`,
      },
    );
  }

  async function save(blob: Blob) {
    const type = blob.type || 'image/webp';
    const file = new File([blob], type === 'image/jpeg' ? 'picture.jpg' : 'picture.webp', {
      type,
    });
    const path = await uploadIndicatorImage(file);
    await setMark({ kind: 'image', path }, 'picture');
    toast.success('Picture updated');
  }

  async function remove() {
    removing = true;
    try {
      await setMark(defaultIndicator(org.id), 'picture');
    } catch {
      /* toasted */
    } finally {
      removing = false;
    }
  }
</script>

<div class="flex items-center gap-4" data-org-picture>
  <Indicator indicator={mark} size="xl" label="{org.name}’s picture" />
  {#if !disabled}
    <div class="flex flex-wrap items-center gap-2">
      <Button icon={Camera} onclick={() => cropper?.pick()}>
        {hasPicture ? 'Change picture' : 'Upload a picture'}
      </Button>
      {#if hasPicture}
        <Button variant="ghost" icon={Trash2} loading={removing} onclick={remove}>Remove</Button>
      {:else}
        <IndicatorField
          value={mark}
          seed={org.id}
          label="Colour, icon or emoji"
          onchange={(i) => void setMark(i, 'mark').catch(() => {})}
        />
      {/if}
    </div>
  {/if}
</div>

<AvatarCropDialog bind:this={cropper} title="Crop {org.name}’s picture" onsave={save} />
