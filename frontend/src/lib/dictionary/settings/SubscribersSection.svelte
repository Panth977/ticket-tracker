<!--
  Dictionary settings › Subscribers (lib/access): every board, artifact and
  agent that may use this dictionary, with Read / Write — and Remove. Either
  side may end a grant: the dictionary's owner, an admin of that board, the
  owner of that artifact or the owner of that agent (dictionaryGrantSet with
  access null). Adding happens in the board's, the artifact's or the agent's
  own Dictionaries list, since a grant needs both sides.
-->
<script lang="ts">
  import type { DictionaryGrant } from '@tm/shared';
  import { command } from '$lib/api';
  import {
    agentView,
    artifactView,
    boardView,
    hiddenView,
    type SubscriberRow,
  } from '$lib/access/entities';
  import {
    AGENT_DICTIONARY,
    ARTIFACT_DICTIONARY,
    BOARD_DICTIONARY,
    can,
  } from '$lib/access/relations';
  import SubscriberList from '$lib/access/SubscriberList.svelte';
  import { myAgents } from '$lib/agents/agents';
  import { myArtifacts, roleIn } from '$lib/artifacts/store';
  import Section from '$lib/board/settings/Section.svelte';
  import { myBoards } from '$lib/stores';
  import { useDictionarySettings } from './context.svelte';

  const s = useDictionarySettings();
  const d = $derived(s.dictionary);
  const boardsQ = $derived(myBoards(s.me));
  const artifactsQ = $derived(myArtifacts(s.me));
  const agentsQ = $derived(myAgents(s.me));
  const boardById = $derived(new Map($boardsQ.data.map((b) => [b.id, b])));
  const artifactById = $derived(new Map($artifactsQ.data.map((a) => [a.id, a])));
  const agentById = $derived(new Map($agentsQ.data.map((g) => [g.id, g])));

  const rows = $derived.by((): SubscriberRow[] => [
    ...Object.entries(d.boards ?? {}).map(([id, access]): SubscriberRow => {
      const b = boardById.get(id);
      return {
        entity: b ? boardView(b) : hiddenView('board', id),
        chips: BOARD_DICTIONARY.chips(BOARD_DICTIONARY.toPerms(access as DictionaryGrant)),
        remove: can.revokeDictionary({
          ownsDictionary: s.isOwner,
          managesOther: b?.access[s.me] === 'admin',
          other: 'board',
        }),
      };
    }),
    ...Object.entries(d.artifacts ?? {}).map(([id, access]): SubscriberRow => {
      const a = artifactById.get(id);
      return {
        entity: a ? artifactView(a) : hiddenView('artifact', id),
        chips: ARTIFACT_DICTIONARY.chips(ARTIFACT_DICTIONARY.toPerms(access as DictionaryGrant)),
        remove: can.revokeDictionary({
          ownsDictionary: s.isOwner,
          managesOther: !!a && roleIn(a, s.me) === 'owner',
          other: 'artifact',
        }),
      };
    }),
    ...Object.entries(d.agents ?? {}).map(([id, access]): SubscriberRow => {
      const g = agentById.get(id);
      return {
        entity: g ? agentView({ id, name: g.name, mine: true }) : hiddenView('agent', id),
        chips: AGENT_DICTIONARY.chips(AGENT_DICTIONARY.toPerms(access as DictionaryGrant)),
        remove: can.revokeDictionary({
          ownsDictionary: s.isOwner,
          managesOther: !!g,
          other: 'agent',
        }),
      };
    }),
  ]);

  async function onremove(r: SubscriberRow): Promise<boolean> {
    const side =
      r.entity.kind === 'board'
        ? { boardId: r.entity.id }
        : r.entity.kind === 'artifact'
          ? { artifactId: r.entity.id }
          : { agentId: r.entity.id };
    try {
      await command(
        'dictionaryGrantSet',
        { dictionaryId: d.id, ...side, access: null },
        { toast: 'Could not remove it' },
      );
      return true;
    } catch {
      return false; // toasted; the list shows the live document
    }
  }
</script>

<Section
  title="Subscribers"
  description="The boards, artifacts and agents that may use this dictionary. A board's members and agents, an artifact's page and an agent wherever it works reach it only through these — orchestrators hand its env-style keys to agents as environment — and nobody gets more than their own role allows. They are added from the board's, the artifact's or the agent's Dictionaries; the dictionary's owner — or that board's admin, that artifact's owner or that agent's owner — can remove one."
>
  <SubscriberList
    name="dictionary"
    {rows}
    loading={$boardsQ.loading || $artifactsQ.loading || $agentsQ.loading}
    empty="Nothing uses this dictionary yet. Add it from a board's or an artifact's Settings › Dictionaries, or an agent's page."
    removeMessage={(r) =>
      r.entity.kind === 'board'
        ? 'Nobody on that board reaches this dictionary through the board any more.'
        : r.entity.kind === 'artifact'
          ? 'That artifact’s page stops reaching this dictionary at once.'
          : 'That agent stops getting this dictionary at once.'}
    {onremove}
  />
</Section>
