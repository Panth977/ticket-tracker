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
import { DescriptionSchema, IndicatorSchema } from '../types/indicator.js';
import { EmailInputSchema } from '../config.js';

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
    /** Default: the next colour of WORKSPACE_COLORS. LEGACY: prefer `indicator`. */
    color: Color.optional(),
    /** indicators.html: the workspace's mark. Default: a colour indicator. */
    indicator: IndicatorSchema.optional(),
    /** indicators.html: what this workspace is for (agents read it). */
    description: DescriptionSchema.optional(),
    boardIds: Ids(BoardIdSchema).optional(),
    artifactIds: Ids(ArtifactRefIdSchema).optional(),
    /** memory.html §F: memories bundled too. */
    memoryIds: Ids(ArtifactRefIdSchema).optional(),
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
    /** indicators.html */
    indicator: IndicatorSchema.optional(),
    /** indicators.html: null clears it. */
    description: DescriptionSchema.optional(),
    position: z.number().optional(),
    /** Replace the whole list (its order is the sidebar's) … */
    boardIds: Ids(BoardIdSchema).optional(),
    artifactIds: Ids(ArtifactRefIdSchema).optional(),
    memoryIds: Ids(ArtifactRefIdSchema).optional(),
    /** … or attach / detach a few (applied after a replacement, if both are given). */
    add: z
      .object({
        boardIds: Ids(BoardIdSchema).optional(),
        artifactIds: Ids(ArtifactRefIdSchema).optional(),
        memoryIds: Ids(ArtifactRefIdSchema).optional(),
      })
      .strict()
      .optional(),
    remove: z
      .object({
        boardIds: Ids(BoardIdSchema).optional(),
        artifactIds: Ids(ArtifactRefIdSchema).optional(),
        memoryIds: Ids(ArtifactRefIdSchema).optional(),
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
    /** memory.html §F */
    memoryId: ArtifactRefIdSchema.optional(),
    hidden: z.boolean(),
  }).refine(
    (r) => [r.boardId, r.artifactId, r.memoryId].filter((x) => x !== undefined).length === 1,
    'Give exactly one of boardId, artifactId or memoryId',
  ),
  res: OkResSchema,
});

/** The one role a workspace share hands out (a board role; 'admin' is 'editor' on artifacts and memories). */
export const WORKSPACE_SHARE_ROLES = ['viewer', 'editor', 'admin'] as const;
export type WorkspaceShareRole = (typeof WORKSPACE_SHARE_ROLES)[number];
/** Addresses per workspaceShare call. */
export const WORKSPACE_SHARE_MAX_EMAILS = 20;

const ShareItemKind = z.enum(['board', 'artifact', 'memory']);

/**
 * Share a workspace (one-shot): invite people to everything in it at once.
 * Nothing new is granted by the workspace itself — each item is shared the way
 * it always is (a board invite, an artifact / memory share), so the board is
 * still the only boundary. Items added to the workspace later are not shared.
 */
export const workspaceShare = defineCommand({
  name: 'workspaceShare',
  source: 'extra',
  scopes: [...SCOPES, 'invites:write'],
  permission:
    "The workspace's owner, a person (never an agent). Each address is invited to every board in it that the owner may invite to (admin, or editor where editors can invite; editors cannot hand out admin), and given the role on every artifact and memory the owner owns ('admin' → 'editor' there). What the owner cannot share is skipped and listed. Each address also gets a copy of the workspace in their sidebar — when they first sign up, if they have no account yet. The board invite limit (50 a day) applies.",
  errors: ['forbidden', 'not_found', 'invalid'],
  req: req({
    workspaceId: WorkspaceIdSchema,
    emails: z.array(EmailInputSchema).min(1).max(WORKSPACE_SHARE_MAX_EMAILS),
    role: z.enum(WORKSPACE_SHARE_ROLES),
    /** Goes into the board invitation e-mails. */
    message: z.string().max(1000).optional(),
  }),
  res: z.object({
    shared: z.array(
      z.object({
        email: z.string(),
        /** Boards invited to (or already a member of). */
        boards: z.number().int(),
        artifacts: z.number().int(),
        memories: z.number().int(),
        /** Their sidebar copy: made now, made when they sign up, or not (50 workspaces already). */
        workspace: z.enum(['copied', 'pending', 'full']),
      }),
    ),
    /** What could not be shared, once per item (the reason is the same for every address). */
    skipped: z.array(z.object({ kind: ShareItemKind, id: z.string(), reason: z.string() })),
  }),
});
