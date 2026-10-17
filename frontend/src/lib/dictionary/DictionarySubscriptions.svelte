<!--
  DICTIONARIES a board, an artifact or an agent uses (lib/access
  Subscriptions) — one component for the three, so they look and behave the
  same: every dictionary granted to it (dictionaryList({ boardId | artifactId
  | agentId }), whoever owns it) with Read / Write; Add offers the
  dictionaries I OWN (myDictionaries, live). Both sides must agree to grant
  (dictionaryGrantSet needs the dictionary's owner, who also manages this
  side); either side may remove one.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { DictionaryGrant, DictionaryOut } from '@tm/shared';
  import { command } from '$lib/api';
  import { dictionaryView, type Candidate, type SubscriptionRow } from '$lib/access/entities';
  import {
    AGENT_DICTIONARY,
    ARTIFACT_DICTIONARY,
    BOARD_DICTIONARY,
    can,
    type Perms,
  } from '$lib/access/relations';
  import SubscriptionList from '$lib/access/SubscriptionList.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { myDictionaries, ownedDictionaries } from './store';

  type Target = { boardId: string } | { artifactId: string } | { agentId: string };
  interface Props {
    target: Target;
    /** Am I the other side's manager (board admin / artifact owner / agent owner)? */
    manages: boolean;
    /** Why nothing can be added or changed right now (archived…), or null. */
    frozen?: string | null;
    /** data-subscriptions value. */
    name: string;
  }
  let { target, manages, frozen = null, name }: Props = $props();

  const other = $derived<'board' | 'artifact' | 'agent'>(
    'boardId' in target ? 'board' : 'artifactId' in target ? 'artifact' : 'agent',
  );
  const relation = $derived(
    other === 'board'
      ? BOARD_DICTIONARY
      : other === 'artifact'
        ? ARTIFACT_DICTIONARY
        : AGENT_DICTIONARY,
  );
  const grantIn = (d: {
    boards?: Record<string, DictionaryGrant>;
    artifacts?: Record<string, DictionaryGrant>;
    agents?: Record<string, DictionaryGrant>;
  }): DictionaryGrant | null =>
    'boardId' in target
      ? (d.boards?.[target.boardId] ?? null)
      : 'artifactId' in target
        ? (d.artifacts?.[target.artifactId] ?? null)
        : (d.agents?.[target.agentId] ?? null);

  // Mine are live (a grant set elsewhere shows at once); dictionaryList answers
  // every one granted here, and is asked again after each change.
  const mineQ = $derived(myDictionaries(auth.uid));
  const owned = $derived(new Map(ownedDictionaries($mineQ.data, auth.uid).map((d) => [d.id, d])));
  const ownSig = $derived([...owned.values()].map((d) => `${d.id}:${grantIn(d) ?? ''}`).join(','));
  const targetKey = $derived(JSON.stringify(target));
  let listed = $state.raw<DictionaryOut[] | null>(null);
  let version = $state(0);
  $effect(() => {
    void ownSig;
    void version;
    const key = targetKey;
    const t = JSON.parse(key) as Target;
    untrack(() =>
      command('dictionaryList', { ...t, includeArchived: true }, { toast: false })
        .then((r) => key === targetKey && (listed = r.dictionaries))
        .catch(() => (listed = listed ?? [])),
    );
  });

  const rows = $derived.by((): SubscriptionRow[] => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, rebuilt on every change
    const out = new Map<string, SubscriptionRow>();
    const row = (
      id: string,
      view: ReturnType<typeof dictionaryView>,
      grant: DictionaryGrant | null | undefined,
      ownsDictionary: boolean,
    ) => {
      if (!grant) return;
      const who = { ownsDictionary, managesOther: manages, other };
      out.set(id, {
        entity: view,
        relation,
        perms: relation.toPerms(grant),
        edit: frozen ?? can.grantDictionary(who),
        remove: can.revokeDictionary(who),
      });
    };
    for (const d of listed ?? []) {
      const mine = owned.get(d.id);
      row(
        d.id,
        dictionaryView(mine ?? d),
        mine ? grantIn(mine) : d.grant,
        !!mine || d.reach === 'manage',
      );
    }
    for (const d of owned.values())
      if (!out.has(d.id)) row(d.id, dictionaryView(d), grantIn(d), true);
    return [...out.values()].sort((a, b) =>
      (a.entity.name ?? '').localeCompare(b.entity.name ?? ''),
    );
  });

  const candidates = $derived<Candidate[]>(
    [...owned.values()]
      .filter((d) => d.archivedAt == null && !rows.some((r) => r.entity.id === d.id))
      .map((d) => ({ entity: dictionaryView(d), relation })),
  );
  const canAdd = $derived(
    !manages
      ? other === 'board'
        ? 'Only board admins choose which dictionaries this board uses'
        : other === 'artifact'
          ? 'Only the artifact’s owner chooses what it uses'
          : 'Only the agent’s owner chooses its dictionaries'
      : (frozen ?? true),
  );

  async function set(dictionaryId: string, access: DictionaryGrant | null, headline: string) {
    try {
      await command('dictionaryGrantSet', { dictionaryId, ...target, access }, { toast: headline });
      version++;
      return true;
    } catch {
      return false; // toasted
    }
  }
  const onsave = (c: Candidate, p: Perms) =>
    set(c.entity.id, relation.fromPerms(p), 'Could not change dictionary access');
  const onremove = (r: SubscriptionRow) =>
    set(r.entity.id, null, 'Could not remove the dictionary');
</script>

<SubscriptionList
  {name}
  {rows}
  {candidates}
  {canAdd}
  loading={listed === null && $mineQ.loading}
  addTitle="Add a dictionary"
  empty={other === 'board'
    ? 'This board uses no dictionary yet.'
    : other === 'artifact'
      ? 'It uses no dictionary yet: BackendDriver.dictionary sees nothing.'
      : 'This agent uses no dictionary of its own yet (it still gets its boards’).'}
  nothingToAdd="Every dictionary you own is already here — or you have none yet (+ › New dictionary in the sidebar)."
  removeMessage={() =>
    other === 'board'
      ? 'Nobody on this board reaches it through the board any more. Its owner can add it again.'
      : other === 'artifact'
        ? 'The page stops reaching it at once. Its owner can add it again.'
        : 'The agent stops getting it at once. Its owner can add it again.'}
  {onsave}
  {onremove}
/>
