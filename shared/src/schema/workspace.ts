/**
 * WORKSPACES (docs/plan/agents.html §AB) — a person's own way of grouping
 * what they can already open. Not §Z's orch workspaces (the workspaces/
 * folder): this is the sidebar.
 *
 *   users/{uid}/workspaces/{workspaceId}   a named bundle of boards and artifacts
 *   users/{uid}/ui/sidebar                 what is hidden from the sidebar's root
 *
 * Both are PRIVATE and PERMISSION-FREE: a workspace grants nothing and narrows
 * nothing, it lists ids the person already reaches. A board they lose access
 * to simply stops showing; the id may stay behind until they edit the
 * workspace. Hiding is only about the sidebar — the board or artifact is not
 * archived, and "All boards & archived" / "All artifacts" still list it.
 */
import { z } from 'zod';
import { BoardIdSchema, MillisSchema } from '../types/primitives.js';

export const WORKSPACE_NAME_MAX = 60;
/** Boards + artifacts in one workspace. */
export const WORKSPACE_ITEMS_MAX = 200;
/** Workspaces per person. */
export const WORKSPACES_MAX = 50;

const ArtifactRefIdSchema = z.string().min(1).max(64);

/** users/{uid}/workspaces/{workspaceId} */
export const WorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX),
  /** '#RRGGBB' — the dot in the sidebar. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** In the order the person put them. */
  boardIds: z.array(BoardIdSchema).max(WORKSPACE_ITEMS_MAX),
  artifactIds: z.array(ArtifactRefIdSchema).max(WORKSPACE_ITEMS_MAX),
  /** memory.html §F — absent on workspaces made before Memory = none. */
  memoryIds: z.array(ArtifactRefIdSchema).max(WORKSPACE_ITEMS_MAX).optional(),
  /** Sidebar order among the person's workspaces (ascending). */
  position: z.number(),
  createdAt: MillisSchema,
  updatedAt: MillisSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceWithId = Workspace & { id: string };

/** users/{uid}/ui/sidebar — hidden from the sidebar's BOARDS / ARTIFACTS root lists. */
export const SidebarPrefsSchema = z.object({
  hiddenBoardIds: z.array(BoardIdSchema),
  hiddenArtifactIds: z.array(ArtifactRefIdSchema),
  /** memory.html §F — absent before Memory = none hidden. */
  hiddenMemoryIds: z.array(ArtifactRefIdSchema).optional(),
  updatedAt: MillisSchema,
});
export type SidebarPrefs = z.infer<typeof SidebarPrefsSchema>;

export const EMPTY_SIDEBAR_PREFS: Omit<SidebarPrefs, 'updatedAt'> = {
  hiddenBoardIds: [],
  hiddenArtifactIds: [],
};

/** The colours a new workspace cycles through (the board palette's hues). */
export const WORKSPACE_COLORS = [
  '#6366F1',
  '#0EA5E9',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#EC4899',
  '#8B5CF6',
  '#64748B',
] as const;
