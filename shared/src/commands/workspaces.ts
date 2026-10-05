/**
 * WORKSPACES (docs/plan/agents.html §AB): a person's own bundles of boards and
 * artifacts, and what they hide from the sidebar's root. Only ever the
 * caller's own documents (users/{actor}/…); a person only, never an agent.
 * They grant nothing: every id must be something the caller already reaches.
 */
import { z } from 'zod';
import { BoardIdSchema } from '../types/index.js';
import { WORKSPACE_ITEMS_MAX, WORKSPACE_NAME_MAX } from '../schema/workspace.js';
import { defineCommand, OkResSchema, req } from './define.js';

const Name = z.string().trim().min(1).max(WORKSPACE_NAME_MAX);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const WorkspaceIdSchema = z.string().min(1).max(64);
const ArtifactRefIdSchema = z.string().min(1).max(64);
const Ids = <T extends z.ZodTypeAny>(id: T) => z.array(id).max(WORKSPACE_ITEMS_MAX);

/** Account-level: what a token that may organise your boards carries (MCP / the Claude app). */
const SCOPES = ['boards:create', 'boards:admin'] as const;

export const workspaceCreate = defineCommand({
  name: 'workspaceCreate',
  source: 'app',
  scopes: [...SCOPES],
  permission: 'Any signed-in person, for themselves (never an agent). 50 workspaces per person.',
  errors: ['forbidden', 'invalid', 'conflict'],
  req: req({
    name: Name,
    /** Default: the next colour of WORKSPACE_COLORS. */
    color: Color.optional(),
    boardIds: Ids(BoardIdSchema).optional(),
    artifactIds: Ids(ArtifactRefIdSchema).optional(),
  }),
  res: z.object({ workspaceId: WorkspaceIdSchema }),
});

export const workspaceUpdate = defineCommand({
  name: 'workspaceUpdate',
  source: 'app',
  scopes: [...SCOPES],
  permission:
    "The workspace's owner only (it lives under their own user doc). Added boards / artifacts must be ones they can open.",
  errors: ['forbidden', 'not_found', 'invalid'],
  req: req({
    workspaceId: WorkspaceIdSchema,
    name: Name.optional(),
    color: Color.optional(),
    position: z.number().optional(),
    /** Replace the whole list (its order is the sidebar's) … */
    boardIds: Ids(BoardIdSchema).optional(),
    artifactIds: Ids(ArtifactRefIdSchema).optional(),
    /** … or attach / detach a few (applied after a replacement, if both are given). */
    add: z
      .object({
        boardIds: Ids(BoardIdSchema).optional(),
        artifactIds: Ids(ArtifactRefIdSchema).optional(),
      })
      .strict()
      .optional(),
    remove: z
      .object({
        boardIds: Ids(BoardIdSchema).optional(),
        artifactIds: Ids(ArtifactRefIdSchema).optional(),
      })
      .strict()
      .optional(),
  }),
  res: OkResSchema,
});

export const workspaceDelete = defineCommand({
  name: 'workspaceDelete',
  source: 'app',
  scopes: [...SCOPES],
  permission: "The workspace's owner only. Its boards and artifacts are untouched.",
  errors: ['forbidden', 'not_found'],
  req: req({ workspaceId: WorkspaceIdSchema }),
  res: OkResSchema,
});

/** Hide from / show again in the sidebar's root BOARDS / ARTIFACTS lists. UI only. */
export const sidebarHide = defineCommand({
  name: 'sidebarHide',
  source: 'app',
  scopes: [...SCOPES],
  permission:
    "Any signed-in person, their own sidebar (never an agent). Nothing about the board or artifact changes: it is not archived, and 'All boards' / 'All artifacts' still list it.",
  errors: ['forbidden', 'invalid'],
  req: req({
    boardId: BoardIdSchema.optional(),
    artifactId: ArtifactRefIdSchema.optional(),
    hidden: z.boolean(),
  }).refine((r) => !!r.boardId !== !!r.artifactId, 'Give exactly one of boardId or artifactId'),
  res: OkResSchema,
});
