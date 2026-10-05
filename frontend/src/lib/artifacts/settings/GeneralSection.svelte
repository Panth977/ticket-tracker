<!--
  Artifact settings › General (owner only): name, description, indicator, the
  read-only-for-viewers switch (§B) — one artifactUpdate with just the keys
  that changed — then archive / restore and delete. Deleting removes every
  build, the source and ALL of the artifact's data, so it asks for the name.
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    ARTIFACT_DESCRIPTION_MAX,
    ARTIFACT_NAME_MAX,
    indicatorOf,
    type Indicator,
  } from '@tm/shared';
  import IndicatorField from '$lib/ui/IndicatorField.svelte';
  import { command, type CommandInput } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import { useDraft } from '$lib/board/settings/draft.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Textarea from '$lib/ui/Textarea.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { useArtifactSettings } from './context.svelte';

  const s = useArtifactSettings();
  const a = $derived(s.artifact);
  const archived = $derived(a.archivedAt != null);

  type G = { name: string; description: string; indicator: Indicator; readOnly: boolean };
  const draft = useDraft<G>(() => ({
    name: s.artifact.name,
    description: s.artifact.description ?? '',
    indicator: indicatorOf(s.artifact, s.artifact.id),
    readOnly: s.artifact.readOnly,
  }));
  const d = $derived(draft.value);

  let saving = $state(false);
  async function save() {
    const base = untrack(() => draft.base);
    const v = draft.value;
    if (!v.name.trim()) return;
    const patch: Omit<CommandInput<'artifactUpdate'>, 'artifactId'> = {};
    if (v.name.trim() !== base.name) patch.name = v.name.trim();
    if (v.description.trim() !== base.description) patch.description = v.description.trim() || null;
    if (JSON.stringify(v.indicator) !== JSON.stringify(base.indicator))
      patch.indicator = v.indicator;
    if (v.readOnly !== base.readOnly) patch.readOnly = v.readOnly;
    if (!Object.keys(patch).length) return draft.reset();
    saving = true;
    try {
      await command('artifactUpdate', { artifactId: a.id, ...patch }, { toast: 'Could not save' });
      draft.commit();
      toast.success('Saved');
    } catch {
      /* toasted; the draft keeps what was typed */
    } finally {
      saving = false;
    }
  }

  let busy = $state<'' | 'archive' | 'delete'>('');
  async function archive() {
    // Read once: the live document flips archivedAt before the toast shows.
    const restoring = archived;
    busy = 'archive';
    try {
      await command(
        'artifactUpdate',
        { artifactId: a.id, archived: !restoring },
        { toast: restoring ? 'Could not restore' : 'Could not archive' },
      );
      toast.success(
        restoring ? 'Artifact restored' : 'Artifact archived',
        restoring ? undefined : 'Its data is read-only now and it is hidden from the sidebar.',
      );
    } catch {
      /* toasted */
    } finally {
      busy = '';
    }
  }

  let deleteOpen = $state(false);
  let confirmName = $state('');
  const confirmed = $derived(confirmName.trim() === a.name);
  async function del() {
    if (!confirmed) return;
    const name = a.name;
    busy = 'delete';
    try {
      await command(
        'artifactDelete',
        { artifactId: a.id },
        { toast: 'Could not delete the artifact' },
      );
      deleteOpen = false;
      toast.success(`${name} is being deleted`);
      void goto(routes.artifacts(), { replaceState: true });
    } catch {
      /* toasted */
    } finally {
      busy = '';
    }
  }
</script>

<Section
  title="General"
  description="What this artifact is called, and what the people it is shared with may do."
  dirty={draft.dirty}
  busy={saving}
  onsave={save}
  onreset={draft.reset}
>
  <div class="grid max-w-xl gap-5">
    <Input
      label="Name"
      value={d.name}
      maxlength={ARTIFACT_NAME_MAX}
      required
      oninput={(e) => (draft.value = { ...d, name: e.currentTarget.value })}
    />
    <Textarea
      label="Description"
      value={d.description}
      maxlength={ARTIFACT_DESCRIPTION_MAX}
      rows={2}
      hint="What it is for — shown in the list of artifacts and in search; agents read it."
      oninput={(e) => (draft.value = { ...d, description: e.currentTarget.value })}
    />
    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium">Indicator</span>
      <IndicatorField
        value={d.indicator}
        seed={a.id}
        label="Artifact indicator"
        onchange={(i) => (draft.value = { ...d, indicator: i })}
      />
    </div>
    <fieldset class="flex flex-col gap-3 rounded-lg border border-line p-4">
      <legend class="px-1 text-sm font-medium">Viewers</legend>
      <Checkbox
        label="Read-only for viewers"
        description="Viewers can open it and see its data, but not change anything. Off, a viewer can write — which is what a poll, a checklist or a form needs."
        checked={d.readOnly}
        onchange={(e) => (draft.value = { ...d, readOnly: e.currentTarget.checked })}
      />
    </fieldset>
  </div>
</Section>

<!-- Outside the Section: these act at once, they are not part of the draft its Save bar saves. -->
<section class="mt-10 flex flex-col gap-3" aria-labelledby="artifact-danger">
  <h3 id="artifact-danger" class="text-sm font-semibold text-muted">Danger zone</h3>
  <div
    class="flex max-w-2xl flex-col divide-y divide-line rounded-xl border border-danger/40 bg-surface"
  >
    <div class="flex flex-wrap items-center gap-3 p-5">
      <div class="min-w-0 flex-1">
        <h3 class="font-medium">{archived ? 'Restore this artifact' : 'Archive this artifact'}</h3>
        <p class="text-sm text-muted">
          {archived
            ? 'Its data can be written again and it goes back in everyone’s sidebar.'
            : 'Hidden from the sidebar; its data becomes read-only and nothing can be published. Nothing is lost.'}
        </p>
      </div>
      <Button
        variant={archived ? 'secondary' : 'danger'}
        loading={busy === 'archive'}
        onclick={() => archive()}>{archived ? 'Restore' : 'Archive'}</Button
      >
    </div>
    <div class="flex flex-wrap items-center gap-3 p-5">
      <div class="min-w-0 flex-1">
        <h3 class="font-medium">Delete this artifact</h3>
        <p class="text-sm text-muted">
          Every build, the source, its files and all of its data are deleted for good, for everyone
          it is shared with.
        </p>
      </div>
      <Button variant="danger" onclick={() => ((confirmName = ''), (deleteOpen = true))}
        >Delete…</Button
      >
    </div>
  </div>
</section>

<Dialog
  bind:open={deleteOpen}
  title="Delete {a.name}?"
  size="sm"
  description="This can't be undone. Type the artifact's name to confirm."
>
  <form id="delete-artifact" onsubmit={(e) => (e.preventDefault(), del())}>
    <Input
      label="Name"
      value={confirmName}
      placeholder={a.name}
      autocomplete="off"
      oninput={(e) => (confirmName = e.currentTarget.value)}
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (deleteOpen = false)}>Cancel</Button>
    <Button
      variant="danger"
      type="submit"
      form="delete-artifact"
      disabled={!confirmed}
      loading={busy === 'delete'}>Delete forever</Button
    >
  {/snippet}
</Dialog>
