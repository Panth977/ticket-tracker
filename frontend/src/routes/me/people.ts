/**
 * Phase 8 (§P2) — who My work may hand a ticket to.
 *
 * The board screen has its BoardState with `peopleChoices` already in it; My
 * work spans boards, so it joins one members listener per board its rows came
 * from (a handful in practice — the same shape as `questionSignalsAcross`).
 * Without them the assignee picker would have nobody to offer.
 */
import { readable, type Readable } from 'svelte/store';
import { paths, type BoardMember } from '@tm/shared';
import { queryStore, type WithId } from '$lib/stores';
import { principalChoices } from '$lib/people/pickers';
import type { ChoiceItem } from '$lib/views/pickers/ChoicePicker.svelte';

/** boardId → the picker items for its people AND agents. */
export function memberChoicesAcross(
  boardIds: readonly string[],
): Readable<Map<string, ChoiceItem[]>> {
  if (!boardIds.length) return readable(new Map());
  const stores = boardIds.map(
    (id) => [id, queryStore<BoardMember>({ path: paths.members(id) })] as const,
  );
  return readable<Map<string, ChoiceItem[]>>(new Map(), (set) => {
    const rows = new Map<string, WithId<BoardMember>[]>();
    const push = () => set(new Map([...rows].map(([id, ms]) => [id, principalChoices(ms)])));
    const offs = stores.map(([id, s]) =>
      s.subscribe((v) => {
        rows.set(id, v.data);
        push();
      }),
    );
    return () => offs.forEach((off) => off());
  });
}
