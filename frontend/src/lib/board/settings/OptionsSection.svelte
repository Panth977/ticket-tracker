<!--
  Board settings › Priorities and › Tags — both a plain option list.
  Removing a priority in use asks for a replacement (409 → remap); removing a
  tag simply takes it off every ticket (the server does that).
-->
<script lang="ts">
  import type { Option } from '@tm/shared';
  import OptionListEditor from './OptionListEditor.svelte';
  import RemapDialog from './RemapDialog.svelte';
  import Section from './Section.svelte';
  import { byPosition, useDraft, useRestore, useSettings } from './draft.svelte';
  import { saveBoard, type Remap } from './save';
  import { routes } from '$lib/layout/routes';

  interface Props {
    kind: 'priorities' | 'tags';
  }
  let { kind }: Props = $props();
  const s = useSettings();
  const draft = useDraft<Option[]>(() => byPosition(s.board[kind]));
  let remapper: RemapDialog | null = $state(null);

  const copy = {
    priorities: {
      title: 'Priorities',
      description:
        'From most to least urgent. The first one sorts to the top; quick add understands “!name” or “!1”.',
      add: 'Add priority',
    },
    tags: {
      title: 'Tags',
      description:
        'Labels anyone who can edit may put on tickets. Removing a tag takes it off every ticket.',
      add: 'Add tag',
    },
  } as const;

  useRestore(() => kind, draft);

  /** Saves in the background; a priority still in use asks where its tickets go, then saves again. */
  function save(remap: Remap = {}) {
    const value = $state.snapshot(draft.value) as typeof draft.value;
    const before = s.board.priorities;
    saveBoard(
      s.board.id,
      { [kind]: value },
      Object.keys(remap).length ? remap : undefined,
      copy[kind].title.toLowerCase(),
      {
        section: kind,
        openTo: routes.boardSettings(s.board.key, kind),
        value,
        onNeeds: async (needs) => {
          draft.value = value;
          if (needs.kind !== 'priority' || !value.length) return;
          const gone = before.find((x) => x.id === needs.id);
          const to = await remapper?.ask({
            kind: 'priority',
            name: gone?.name ?? 'a removed priority',
            count: needs.count,
            choices: value.map((x) => ({ id: x.id, name: x.name })),
          });
          if (to) save({ ...remap, priorities: { ...remap.priorities, [needs.id]: to } });
        },
      },
    );
    draft.commit();
  }
</script>

<Section
  title={copy[kind].title}
  description={copy[kind].description}
  dirty={draft.dirty}
  readOnly={s.readOnly}
  onsave={save}
  onreset={draft.reset}
>
  <div class="max-w-xl">
    <OptionListEditor
      label={copy[kind].title}
      items={draft.value}
      onchange={(xs) => (draft.value = xs)}
      addLabel={copy[kind].add}
      readOnly={s.readOnly}
    />
  </div>
</Section>

<RemapDialog bind:this={remapper} />
