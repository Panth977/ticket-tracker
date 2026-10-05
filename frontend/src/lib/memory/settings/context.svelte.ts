/**
 * What every memory-settings section reads: the live memory and who I am on
 * it. Provided by routes/m/[memoryId]/settings/+layout.svelte (as artifact
 * settings do).
 */
import { getContext, setContext } from 'svelte';
import type { Memory, MemoryRole } from '@tm/shared';
import type { WithId } from '$lib/stores';

export interface MemorySettings {
  readonly memory: WithId<Memory>;
  readonly me: string;
  readonly role: MemoryRole;
  readonly isOwner: boolean;
}

const KEY = Symbol('memory-settings');
export const provideMemorySettings = (s: MemorySettings): void => {
  setContext(KEY, s);
};
export const useMemorySettings = (): MemorySettings => getContext<MemorySettings>(KEY);
