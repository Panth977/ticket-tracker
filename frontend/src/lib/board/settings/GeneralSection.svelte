<!--
  Board settings › General: name, key (fixed once created), colour, the
  default view, and the board-wide switches (settings.*). One boardUpdate with
  just the keys that changed.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { BoardPatch, BoardSettings } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { boardViews } from '$lib/stores';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import ColorSwatch, { PALETTE } from '$lib/ui/ColorSwatch.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Section from './Section.svelte';
  import { useDraft, useRestore, useSettings } from './draft.svelte';
  import { saveBoard } from './save';
  import { routes } from '$lib/layout/routes';

  const s = useSettings();
  type G = {
    name: string;
    color: string;
    icon: string;
    defaultViewId: string;
    settings: BoardSettings;
  };
  const draft = useDraft<G>(() => ({
    name: s.board.name,
    color: s.board.color,
    icon: s.board.icon,
    defaultViewId: s.board.defaultViewId,
    settings: {
      allowDelete: s.board.settings.allowDelete,
      emailReplies: s.board.settings.emailReplies,
      autoArchiveDoneAfterDays: s.board.settings.autoArchiveDoneAfterDays,
      editorsCanInvite: s.board.settings.editorsCanInvite ?? false,
    },
  }));
  const views = $derived(boardViews(s.board.id, auth.uid));
  const shared = $derived($views.data.filter((v) => v.scope === 'shared'));
  const d = $derived(draft.value);
  const ro = $derived(s.readOnly);

  const AUTO_ARCHIVE = [null, 7, 14, 30, 60, 90, 180] as const;

  function save() {
    const base = untrack(() => draft.base);
    const v = draft.value;
    if (!v.name.trim()) return;
    const patch: BoardPatch = {};
    if (v.name.trim() !== base.name) patch.name = v.name.trim();
    if (v.color !== base.color) patch.color = v.color;
    if (v.icon !== base.icon) patch.icon = v.icon;
    if (v.defaultViewId !== base.defaultViewId) patch.defaultViewId = v.defaultViewId;
    const changed = (Object.keys(v.settings) as (keyof BoardSettings)[]).filter(
      (k) => v.settings[k] !== base.settings[k],
    );
    if (changed.length) patch.settings = Object.fromEntries(changed.map((k) => [k, v.settings[k]]));
    if (!Object.keys(patch).length) return;
    saveBoard(s.board.id, patch, undefined, 'general settings', {
      section: 'general',
      openTo: routes.boardSettings(s.board.key, 'general'),
      value: $state.snapshot(v),
    });
    draft.commit();
  }
  useRestore(() => 'general', draft);
</script>

<Section
  title="General"
  description="What this board is called and how it behaves for everyone on it."
  dirty={draft.dirty}
  readOnly={ro}
  onsave={save}
  onreset={draft.reset}
>
  <div class="grid max-w-xl gap-5">
    <Input
      label="Name"
      value={d.name}
      maxlength={80}
      required
      disabled={ro}
      oninput={(e) => (draft.value = { ...d, name: e.currentTarget.value })}
    />
    <Input
      label="Key"
      value={s.board.key}
      disabled
      hint="Fixed once created — every ticket's number (#{s.board.key}-42) and link uses it."
    />
    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium">Colour</span>
      {#if ro}<ColorSwatch color={d.color} size={18} />
      {:else}<ColorSwatch
          value={d.color}
          options={PALETTE}
          label="Board colour"
          onchange={(c) => (draft.value = { ...d, color: c })}
        />{/if}
    </div>
    <Input
      label="Icon"
      value={d.icon}
      maxlength={64}
      disabled={ro}
      hint="An emoji shown next to the board in the sidebar."
      oninput={(e) => (draft.value = { ...d, icon: e.currentTarget.value })}
    />
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Default view</span>
      <select
        class="h-9 w-64 rounded-md border border-line bg-surface px-2"
        value={d.defaultViewId}
        disabled={ro}
        onchange={(e) => (draft.value = { ...d, defaultViewId: e.currentTarget.value })}
      >
        {#each shared as v (v.id)}<option value={v.id}>{v.name}</option>{/each}
        {#if !shared.some((v) => v.id === d.defaultViewId)}<option value={d.defaultViewId}
            >(current)</option
          >{/if}
      </select>
      <span class="text-xs text-muted"
        >Where people land when they open the board for the first time. Must be a shared view.</span
      >
    </label>

    <fieldset class="flex flex-col gap-3 rounded-lg border border-line p-4">
      <legend class="px-1 text-sm font-medium">Behaviour</legend>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Auto-archive done tickets after</span>
        <select
          class="h-9 w-48 rounded-md border border-line bg-surface px-2"
          disabled={ro}
          value={String(d.settings.autoArchiveDoneAfterDays ?? '')}
          onchange={(e) => {
            const v = e.currentTarget.value;
            draft.value = {
              ...d,
              settings: { ...d.settings, autoArchiveDoneAfterDays: v ? Number(v) : null },
            };
          }}
        >
          {#each AUTO_ARCHIVE as n (n)}<option value={String(n ?? '')}
              >{n == null ? 'Never' : `${n} days`}</option
            >{/each}
          {#if d.settings.autoArchiveDoneAfterDays != null && !AUTO_ARCHIVE.includes(d.settings.autoArchiveDoneAfterDays as never)}
            <option value={String(d.settings.autoArchiveDoneAfterDays)}
              >{d.settings.autoArchiveDoneAfterDays} days</option
            >
          {/if}
        </select>
      </label>
      <Checkbox
        label="Editors can invite"
        description="Otherwise only admins can invite people to this board."
        disabled={ro}
        checked={d.settings.editorsCanInvite ?? false}
        onchange={(e) =>
          (draft.value = {
            ...d,
            settings: { ...d.settings, editorsCanInvite: e.currentTarget.checked },
          })}
      />
      <Checkbox
        label="Email replies become comments"
        description="Replying to a notification email posts in the ticket's thread."
        disabled={ro}
        checked={d.settings.emailReplies}
        onchange={(e) =>
          (draft.value = {
            ...d,
            settings: { ...d.settings, emailReplies: e.currentTarget.checked },
          })}
      />
      <Checkbox
        label="Allow permanent delete"
        description="Lets admins delete tickets (and this board) for good. Off = archive only."
        disabled={ro}
        checked={d.settings.allowDelete}
        onchange={(e) =>
          (draft.value = {
            ...d,
            settings: { ...d.settings, allowDelete: e.currentTarget.checked },
          })}
      />
    </fieldset>
  </div>
</Section>
