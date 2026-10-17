/**
 * What every dictionary-settings section reads: the live dictionary and who I
 * am on it. Provided by routes/dictionary/[dictionaryId]/settings/+layout.svelte
 * (as bucket settings do).
 */
import { getContext, setContext } from 'svelte';
import type { Dictionary, DictionaryRole } from '@tm/shared';
import type { WithId } from '$lib/stores';

export interface DictionarySettings {
  readonly dictionary: WithId<Dictionary>;
  readonly me: string;
  readonly role: DictionaryRole;
  readonly isOwner: boolean;
}

const KEY = Symbol('dictionary-settings');
export const provideDictionarySettings = (s: DictionarySettings): void => {
  setContext(KEY, s);
};
export const useDictionarySettings = (): DictionarySettings => getContext<DictionarySettings>(KEY);
