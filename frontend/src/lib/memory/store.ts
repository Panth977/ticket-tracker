/**
 * MEMORY as the app reads it (docs/plan/memory.html §F): live Firestore
 * listeners (shared and ref-counted like every store in $lib/stores) and the
 * pure helpers the sidebar, the list page, ⌘K and settings sort with.
 *
 * Reads are direct for the memory's own people (the rules let anyone in
 * `access` read the document and its nodes); every WRITE is a command.
 */
import type { Readable } from 'svelte/store';
import {
  memoryCan,
  memoryReach,
  paths,
  type Memory,
  type MemoryReach,
  type MemoryRole,
  type MemoryNode,
} from '@tm/shared';
import { docStore, queryStore, type DocState, type QueryState, type WithId } from '$lib/stores';

/** Every memory I have a role on (archived included — see splitMemories). */
export function myMemories(uid: string | null | undefined): Readable<QueryState<Memory>> {
  return queryStore<Memory>(
    uid ? { path: paths.memories(), where: [['memberUids', 'array-contains', uid]] } : null,
  );
}

/** One memory, live. permission-denied means "not shared with me" (or no longer). */
export function memoryDoc(id: string | null | undefined): Readable<DocState<Memory>> {
  return docStore<Memory>(id ? paths.memory(id) : null);
}

/** Every node of one memory — the tree is built client-side (D-M1: ≤ 10,000, small rows). */
export function memoryNodes(id: string | null | undefined): Readable<QueryState<MemoryNode>> {
  return queryStore<MemoryNode>(id ? { path: paths.memoryNodes(id) } : null);
}

// ── pure ─────────────────────────────────────────────────────────────────────

export function memoryRoleIn(
  m: Pick<Memory, 'access'> | null | undefined,
  uid: string | null | undefined,
): MemoryRole | null {
  return (uid && m?.access?.[uid]) || null;
}

/** What I may do here as a direct member (board grants are reached through the API, §D). */
export function myReach(
  m: (Pick<Memory, 'access' | 'boards' | 'archivedAt'> & { deletingAt?: number | null }) | null,
  uid: string | null | undefined,
): MemoryReach {
  return m ? memoryReach(m, { uid }) : null;
}

export const canWrite = (r: MemoryReach): boolean => memoryCan.write(r);
export const canManage = (r: MemoryReach): boolean => memoryCan.manage(r);

export function splitMemories<T extends Pick<Memory, 'name' | 'archivedAt'>>(
  list: readonly T[],
): { active: T[]; archived: T[] } {
  return {
    active: list.filter((m) => m.archivedAt == null).sort((a, b) => a.name.localeCompare(b.name)),
    archived: list
      .filter((m) => m.archivedAt != null)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  };
}

export const MEMORY_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', owner: true },
  { id: 'people', label: 'People', owner: true },
  /** lib/access: the boards and artifacts that use it. */
  { id: 'subscribers', label: 'Subscribers', owner: false },
] as const;
export type MemorySettingsSection = (typeof MEMORY_SETTINGS_SECTIONS)[number]['id'];

/** The owner sees all; an editor or viewer only Subscribers. */
export function memorySettingsFor(
  role: MemoryRole | null,
): readonly { id: MemorySettingsSection; label: string }[] {
  if (role === 'owner') return MEMORY_SETTINGS_SECTIONS;
  if (role) return MEMORY_SETTINGS_SECTIONS.filter((s) => !s.owner);
  return [];
}

/** People on it: owner, editors, viewers. */
export function memoryAccessRows(m: Pick<Memory, 'access'>): { uid: string; role: MemoryRole }[] {
  const order: Record<MemoryRole, number> = { owner: 0, editor: 1, viewer: 2 };
  return Object.entries(m.access)
    .map(([uid, role]) => ({ uid, role }))
    .sort((x, y) => order[x.role] - order[y.role] || x.uid.localeCompare(y.uid));
}

/** A file's mode: rendered, or the text in an editor (memory.html §F). */
export type FileMode = 'preview' | 'code';

/** The view a person last used — Tree or Folders — remembered per browser. */
export type MemoryView = 'tree' | 'folders';
const VIEW_KEY = 'tm.memory.view';
export function savedMemoryView(): MemoryView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'folders' ? 'folders' : 'tree';
  } catch {
    return 'tree';
  }
}
export function saveMemoryView(v: MemoryView): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* private mode */
  }
}

export type { WithId };
