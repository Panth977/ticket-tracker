/**
 * What every artifact-settings section reads: the live artifact and who I am
 * on it. Provided by routes/x/[artifactId]/settings/+layout.svelte — the same
 * arrangement as board settings (lib/board/settings/draft.svelte.ts), whose
 * useDraft the sections here reuse as it is.
 */
import { getContext, setContext } from 'svelte';
import type { Artifact, ArtifactRole } from '@tm/shared';
import type { WithId } from '$lib/stores';

export interface ArtifactSettings {
  readonly artifact: WithId<Artifact>;
  readonly me: string;
  readonly role: ArtifactRole;
  /** artifactCan.manage — General and People, archive, delete, Delete all data. */
  readonly isOwner: boolean;
  /** artifactCan.publish — Builds. */
  readonly canPublish: boolean;
}

const KEY = Symbol('artifact-settings');

export function provideArtifactSettings(s: ArtifactSettings): void {
  setContext(KEY, s);
}
export function useArtifactSettings(): ArtifactSettings {
  return getContext<ArtifactSettings>(KEY);
}
