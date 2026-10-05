/**
 * Artifacts as the app reads them (docs/plan/artifacts.html §F, §G): live
 * Firestore listeners, shared and ref-counted like every other store
 * ($lib/stores), plus the pure helpers the sidebar, the list page, ⌘K and the
 * settings screens all sort and filter with.
 *
 * Reads are direct from Firestore (the rules let anyone in `access` read the
 * document and its builds); every WRITE is a command.
 */
import type { Readable } from 'svelte/store';
import {
  artifactCan,
  COLLECTIONS,
  type Artifact,
  type ArtifactBuild,
  type ArtifactRole,
} from '@tm/shared';
import {
  docStore,
  queryStore,
  type DocState,
  type QuerySpec,
  type QueryState,
  type WithId,
} from '$lib/stores';

/** Document paths. (paths.* in @tm/shared has no artifact entries yet; these are the §G layout.) */
export const artifactPaths = {
  artifacts: () => COLLECTIONS.artifacts,
  artifact: (id: string) => `${COLLECTIONS.artifacts}/${id}`,
  builds: (id: string) => `${COLLECTIONS.artifacts}/${id}/${COLLECTIONS.builds}`,
  build: (id: string, buildId: string) =>
    `${COLLECTIONS.artifacts}/${id}/${COLLECTIONS.builds}/${buildId}`,
};

/**
 * THE LISTING QUERY — the one place that knows how "the artifacts I have a
 * role on" is asked. Firestore cannot query "map has key", so the document
 * carries the uids of `access` as an array, the same trick as a board's
 * readerUids. If the backend names or shapes that differently, change THIS
 * function and nothing else.
 */
export function myArtifactsSpec(uid: string): QuerySpec {
  return { path: artifactPaths.artifacts(), where: [['memberUids', 'array-contains', uid]] };
}

/** Every artifact I have a role on (archived included — see splitArtifacts). */
export function myArtifacts(uid: string | null | undefined): Readable<QueryState<Artifact>> {
  return queryStore<Artifact>(uid ? myArtifactsSpec(uid) : null);
}

/** One artifact, live. Errors (permission-denied) mean "not shared with me" — or no longer. */
export function artifactDoc(id: string | null | undefined): Readable<DocState<Artifact>> {
  return docStore<Artifact>(id ? artifactPaths.artifact(id) : null);
}

/** Housekeeping keeps ten builds (ARTIFACT_BUILDS_KEPT); a little headroom for the day between sweeps. */
export const BUILDS_SHOWN = 30;

/** Its builds, newest first. */
export function artifactBuilds(id: string | null | undefined): Readable<QueryState<ArtifactBuild>> {
  return queryStore<ArtifactBuild>(
    id
      ? { path: artifactPaths.builds(id), orderBy: [['createdAt', 'desc']], limit: BUILDS_SHOWN }
      : null,
  );
}

export function artifactBuild(
  id: string | null | undefined,
  buildId: string | null | undefined,
): Readable<DocState<ArtifactBuild>> {
  return docStore<ArtifactBuild>(id && buildId ? artifactPaths.build(id, buildId) : null);
}

// ── pure ─────────────────────────────────────────────────────────────────────

type AccessOf = Pick<Artifact, 'access'>;

/** My role, or null when I have none (the artifact is then not mine to see). */
export function roleIn(
  a: AccessOf | null | undefined,
  uid: string | null | undefined,
): ArtifactRole | null {
  return (uid && a?.access?.[uid]) || null;
}

/**
 * May this viewer NOT write the artifact's data? The one boolean the driver's
 * `me.readOnly` and the broker's up-front refusal both mean. An archived
 * artifact takes no data writes from anyone (§E4).
 */
export function viewerReadOnly(
  a: Pick<Artifact, 'readOnly' | 'archivedAt'>,
  role: ArtifactRole | null,
): boolean {
  return a.archivedAt != null || !artifactCan.writeData(role, a.readOnly);
}

/** What the settings menu offers each role (§B): owners everything, editors the build and its data. */
export const ARTIFACT_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', owner: true },
  { id: 'people', label: 'People', owner: true },
  { id: 'boards', label: 'Board access', owner: true },
  { id: 'builds', label: 'Builds', owner: false },
  { id: 'data', label: 'Data', owner: false },
] as const;
export type ArtifactSettingsSection = (typeof ARTIFACT_SETTINGS_SECTIONS)[number]['id'];

export function settingsSectionsFor(
  role: ArtifactRole | null,
): readonly { id: ArtifactSettingsSection; label: string }[] {
  if (artifactCan.manage(role)) return ARTIFACT_SETTINGS_SECTIONS;
  if (artifactCan.publish(role)) return ARTIFACT_SETTINGS_SECTIONS.filter((s) => !s.owner);
  return [];
}

/** Where the ⚙ goes for this role — null for viewers, who get no settings link at all. */
export function firstSettingsSection(role: ArtifactRole | null): ArtifactSettingsSection | null {
  return settingsSectionsFor(role)[0]?.id ?? null;
}

export interface ArtifactGroups<T> {
  /** Not archived, by name — the sidebar and the top of the list page. */
  active: T[];
  /** Archived, most recently archived first. */
  archived: T[];
}

export function splitArtifacts<T extends Pick<Artifact, 'name' | 'archivedAt'>>(
  list: readonly T[],
): ArtifactGroups<T> {
  const active = list
    .filter((a) => a.archivedAt == null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const archived = list
    .filter((a) => a.archivedAt != null)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  return { active, archived };
}

/** People on it (owner first, then editors, then viewers) and its agents — for the People section. */
export function accessRows(
  a: Pick<Artifact, 'access' | 'ownerUid'>,
): { uid: string; role: ArtifactRole }[] {
  const order: Record<ArtifactRole, number> = { owner: 0, editor: 1, viewer: 2 };
  return Object.entries(a.access)
    .map(([uid, role]) => ({ uid, role }))
    .sort((x, y) => order[x.role] - order[y.role] || x.uid.localeCompare(y.uid));
}

/** The glyph shown beside the name: its emoji, or the default. */
export const artifactGlyph = (a: Pick<Artifact, 'icon'> | null | undefined): string =>
  a?.icon || '◆';

/** 'a1B2c3…' — enough of a build id to tell two apart in a label. */
export const shortBuild = (buildId: string | null | undefined): string =>
  buildId ? buildId.slice(0, 6) : '';

export type { WithId };
