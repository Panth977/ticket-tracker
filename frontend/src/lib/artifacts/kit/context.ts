/**
 * What ArtifactHost lends the Code tab (a tab panel is only given
 * { artifactId, role }): the build on screen, and a way to get a host API for
 * the dev engine's preview — through a broker of its own, with the same
 * viewer, role and grants as the Website.
 */
import { getContext, setContext } from 'svelte';
import type { CompiledArtifact } from '@panth977/sandbox/protocol';
import type { KitApi } from './bridgeApi';

export interface KitHost {
  /** The artifact's name. */
  name(): string;
  /** Has anything been published? */
  hasBuild(): boolean;
  /** The build on screen: its id and capability URL, or null (nothing published / not open yet). */
  opened(): { buildId: string; contentUrl: string } | null;
  /** That build's compiled artifact; null for a classic static build; undefined while checking. */
  kit(): CompiledArtifact | null | undefined;
  /** A host API for a preview frame. Call close() when the frame goes. */
  previewApi(): { api: KitApi; close(): void };
}

const KEY = Symbol('kit-host');
export const setKitHost = (h: KitHost) => setContext(KEY, h);
export const getKitHost = (): KitHost | undefined => getContext<KitHost | undefined>(KEY);
