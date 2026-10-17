/**
 * THE HOST PAGE'S TABS (/x/{id}?tab=…): the running site, and beside it a
 * look at what it keeps — its Firestore documents, its Realtime Database
 * tree, the buckets it was granted. A tab is one entry here; the host draws
 * the bar and the panel from this list and nothing else.
 *
 *   website   the sandboxed iframe (ArtifactHost itself — kept mounted, so
 *             switching away and back never reloads somebody's dashboard)
 *   db        DbTab — collections → documents → a document
 *   json      JsonTab — the RTDB node, live, as a tree
 *   bucket    BucketTab — the granted buckets the viewer reaches
 *   dictionary DictionaryTab — the granted dictionaries the viewer reaches
 *
 * `data`: owner and editors only (artifactCan.publish, as the settings' Data
 * section); everyone else gets the host's "only the owner and editors" panel.
 */
import type { Component } from 'svelte';
import { AppWindow, BookA, Braces, Brain, Database } from 'lucide-svelte';
import type { ArtifactRole } from '@tm/shared';
import type { IconComponent } from '$lib/ui/types';
import BucketTab from './BucketTab.svelte';
import DbTab from './DbTab.svelte';
import DictionaryTab from './DictionaryTab.svelte';
import JsonTab from './JsonTab.svelte';

/** What every tab panel is given. */
export interface ArtifactTabProps {
  artifactId: string;
  role: ArtifactRole;
}

export interface ArtifactTab {
  id: string;
  label: string;
  icon: IconComponent;
  /** The artifact's own data: owner and editors only. */
  data?: boolean;
  /** Absent for the website, which the host draws itself. */
  panel?: Component<ArtifactTabProps>;
}

export const ARTIFACT_TABS: readonly ArtifactTab[] = [
  { id: 'website', label: 'Website', icon: AppWindow },
  { id: 'db', label: 'DB', icon: Database, data: true, panel: DbTab },
  { id: 'json', label: 'JSON', icon: Braces, data: true, panel: JsonTab },
  { id: 'bucket', label: 'Bucket', icon: Brain, panel: BucketTab },
  { id: 'dictionary', label: 'Dictionary', icon: BookA, panel: DictionaryTab },
];

export const DEFAULT_ARTIFACT_TAB = 'website';

/** ?tab= → a known tab (anything else, or nothing, is the website). */
export function parseArtifactTab(raw: string | null | undefined): ArtifactTab {
  return ARTIFACT_TABS.find((t) => t.id === raw) ?? ARTIFACT_TABS[0]!;
}

/**
 * The URL of `tab` from where we are: the same path (owner-first or not),
 * ?tab= set — or dropped for the website — and the other tabs' own
 * parameters (path, bucket, mode, dictionary) left behind. ?full= stays.
 */
export function artifactTabHref(url: URL, tab: string): string {
  const u = new URL(url);
  for (const k of ['tab', 'path', 'bucket', 'mode', 'dictionary']) u.searchParams.delete(k);
  if (tab !== DEFAULT_ARTIFACT_TAB) u.searchParams.set('tab', tab);
  return `${u.pathname}${u.search}`;
}

/** The current URL with `set` applied (null deletes), for a tab's own ?path= / ?bucket=. */
export function withParams(url: URL, set: Record<string, string | null>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(set))
    if (v === null || v === '') u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  return `${u.pathname}${u.search}`;
}
