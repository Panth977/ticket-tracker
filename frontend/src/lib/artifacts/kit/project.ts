/**
 * ONE PROJECT, ONE TREE. The Code tab shows an artifact's frontend and backend together:
 * everything under /backend is the backend, and the rest is the frontend.
 */
import type { ArtifactBackendDiagnostic, ArtifactBackendFile } from '@tm/shared';
import { ARTIFACT_BACKEND_ENTRY, ARTIFACT_BACKEND_SANDBOX_API, ARTIFACT_BACKEND_STARTER } from '@tm/shared';
import type { SourceFiles } from './build';

const DIR = '/backend/';
export const BACKEND_ENTRY = `${DIR}${ARTIFACT_BACKEND_ENTRY}`;
/** Provided by TaskManager: a build always restores it. */
export const BACKEND_API = `${DIR}sandboxApi.ts`;

export const isBackendPath = (path: string): boolean => path.startsWith(DIR);
export const hasBackend = (files: SourceFiles): boolean => BACKEND_ENTRY in files;

export function frontendFiles(files: SourceFiles): SourceFiles {
  return Object.fromEntries(Object.entries(files).filter(([p]) => !isBackendPath(p)));
}

/** The tree's backend → what artifactBackendBuild takes. */
export function backendFiles(files: SourceFiles): ArtifactBackendFile[] {
  return Object.entries(files)
    .filter(([p]) => isBackendPath(p) && p !== BACKEND_API)
    .map(([p, content]) => ({ path: p.slice(DIR.length), content }));
}

/** Stored backend files, or the starter → tree entries, with the current API file. */
export function backendTree(files?: readonly ArtifactBackendFile[] | null): SourceFiles {
  const out: SourceFiles = files?.length
    ? Object.fromEntries(files.map((f) => [`${DIR}${f.path}`, f.content]))
    : { [BACKEND_ENTRY]: ARTIFACT_BACKEND_STARTER };
  out[BACKEND_API] = ARTIFACT_BACKEND_SANDBOX_API;
  return out;
}

/** A frontend's files with the live backend laid over, which wins over a stale copy in a zip. */
export function withBackend(front: SourceFiles, live?: readonly ArtifactBackendFile[] | null): SourceFiles {
  const zipped = Object.entries(front).filter(([p]) => isBackendPath(p));
  if (live?.length) return { ...frontendFiles(front), ...backendTree(live) };
  if (zipped.some(([p]) => p === BACKEND_ENTRY)) return { ...front, [BACKEND_API]: ARTIFACT_BACKEND_SANDBOX_API };
  return front;
}

/** A compile on the worker names files as it knows them; the tree has them under /backend. */
export function backendProblems(list: readonly ArtifactBackendDiagnostic[]) {
  return list.map((d) => ({ ...d, file: d.file ? `${DIR}${d.file}` : undefined, source: d.source as never }));
}
