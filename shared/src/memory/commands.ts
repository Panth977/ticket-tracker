/**
 * MEMORY (docs/plan/memory.html §G) — the commands. Every door (the app's
 * /api, /v1 REST, MCP) calls these.
 *
 * Tokens: `memory:read` / `memory:write`. An account token or an OAuth grant
 * reaches what its person reaches; an agent token reaches only memories
 * granted to a board the agent is on (§B, D-M4). memoryReach() decides.
 *
 * NODES ARE NAMED BY PATH or by id: exactly one of `path` / `nodeId` where a
 * node is the target. Writing a path creates its missing parent folders.
 */
import { z } from 'zod';
import { ArtifactIdSchema } from '../artifacts/schema.js';
import { defineCommand, OkResSchema, req } from '../commands/define.js';
import { EmailInputSchema } from '../config.js';
import { BoardIdSchema, MillisSchema, StoragePathSchema } from '../types/index.js';
import {
  MEMORY_DESCRIPTION_MAX,
  MEMORY_NAME_MAX,
  MemoryGrantSchema,
  MemoryIdSchema,
  MemoryNodeIdSchema,
  MemoryNodeKindSchema,
  MemoryPathSchema,
  MemoryShareRoleSchema,
  MemoryFileSchema,
} from './schema.js';
import { BoardAttachMemorySchema } from './attach.js';
import { IndicatorSchema } from '../types/indicator.js';

const Name = z.string().trim().min(1).max(MEMORY_NAME_MAX);
const Description = z.string().trim().max(MEMORY_DESCRIPTION_MAX);
const Icon = z.string().max(16);
/** What a caller may type as a path: normalized by the handler (normalizeMemoryPath). */
const PathInput = z.string().max(1024);

/** A node, by path or by id — exactly one. */
const nodeTarget = {
  path: PathInput.optional(),
  nodeId: MemoryNodeIdSchema.optional(),
};
function exactlyOne(
  r: { path?: string | undefined; nodeId?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if ((r.path === undefined) === (r.nodeId === undefined))
    ctx.addIssue({ code: 'custom', path: ['path'], message: 'Give exactly one of path or nodeId' });
}

/** A node as the API returns it (the stored node, flattened, with its id). */
export const MemoryNodeOutSchema = z.object({
  id: MemoryNodeIdSchema,
  kind: MemoryNodeKindSchema,
  parentId: MemoryNodeIdSchema.nullable(),
  name: z.string(),
  path: MemoryPathSchema,
  file: MemoryFileSchema.omit({ storagePath: true }).nullable(),
  updatedAt: MillisSchema,
});
export type MemoryNodeOut = z.infer<typeof MemoryNodeOutSchema>;

/** A memory as the API returns it, with what the CALLER may do there. */
export const MemoryOutSchema = z.object({
  id: MemoryIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  /** LEGACY: the typed emoji, if any. Read `indicator`. */
  icon: z.string().nullable(),
  /** indicators.html: always present (read through indicatorOf for old memories). */
  indicator: IndicatorSchema,
  reach: z.enum(['manage', 'write', 'read']),
  archived: z.boolean(),
  stats: z.object({ files: z.number(), folders: z.number(), bytes: z.number() }),
  updatedAt: MillisSchema,
  /**
   * memoryList({ boardId }) only: THAT board's grant (§D). It tells the attach
   * dialog which memories a ticket file may go into (§J: 'write') — which the
   * caller's own `reach` cannot (a commenter reads either way).
   */
  boardGrant: MemoryGrantSchema.optional(),
});
export type MemoryOut = z.infer<typeof MemoryOutSchema>;

// ─── the bucket ──────────────────────────────────────────────────────────────

export const memoryCreate = defineCommand({
  name: 'memoryCreate',
  source: 'app',
  scopes: ['memory:write'],
  permission:
    'Any allowed person, or an account token / OAuth grant with memory:write; they become its owner. Never an agent token (an agent reaches memory through boards, D-M4).',
  errors: ['forbidden', 'invalid', 'conflict'],
  req: req({
    name: Name,
    description: Description.nullable().optional(),
    /** LEGACY (old clients): one emoji. Prefer `indicator`. */
    icon: Icon.nullable().optional(),
    /** indicators.html: the memory's mark (colour, icon, emoji or uploaded image). */
    indicator: IndicatorSchema.optional(),
  }),
  res: z.object({ memoryId: MemoryIdSchema }),
});

export const memoryUpdate = defineCommand({
  name: 'memoryUpdate',
  source: 'app',
  scopes: ['memory:write'],
  permission: 'Owner only (404 to anyone who cannot reach it, 403 to editors/viewers).',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    memoryId: MemoryIdSchema,
    name: Name.optional(),
    description: Description.nullable().optional(),
    /** LEGACY (old clients): one emoji. Prefer `indicator`. */
    icon: Icon.nullable().optional(),
    /** indicators.html */
    indicator: IndicatorSchema.optional(),
    /** Archive (read-only, hidden from the sidebar) or restore. */
    archived: z.boolean().optional(),
  }),
  res: OkResSchema,
});

export const memoryDelete = defineCommand({
  name: 'memoryDelete',
  source: 'app',
  scopes: ['memory:write'],
  permission:
    'Owner only. Empties access and grants at once (nobody reaches it from then on) and queues the job that removes the files, the nodes and then the document. Tickets that point at its files keep a row that reads as gone.',
  errors: ['not_found', 'forbidden'],
  req: req({ memoryId: MemoryIdSchema }),
  res: OkResSchema,
});

export const memoryShare = defineCommand({
  name: 'memoryShare',
  source: 'app',
  scopes: ['memory:write'],
  permission:
    "Owner only — never an agent. A person's role by email ('editor' | 'viewer'; null removes). An address with no account yet → an invite (invites/ with memoryId). The owner's own role cannot be changed.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({
    memoryId: MemoryIdSchema,
    email: EmailInputSchema,
    role: MemoryShareRoleSchema.nullable(),
  }),
  res: z.object({ ok: z.literal(true), invited: z.boolean() }),
});

/**
 * §D — let a board or an artifact use this memory, or stop it. A ceiling: what
 * a member then does is bounded by their own role (memoryReach).
 */
export const memoryGrantSet = defineCommand({
  name: 'memoryGrantSet',
  source: 'app',
  scopes: ['memory:write'],
  permission:
    "Granting: the memory's OWNER, who must also be an admin of the board (or the owner of the artifact). Removing (access null): the memory's owner, OR an admin of that board, OR the owner of that artifact — either side may end it. Exactly one of boardId / artifactId. Never an agent.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({
    memoryId: MemoryIdSchema,
    boardId: BoardIdSchema.optional(),
    artifactId: ArtifactIdSchema.optional(),
    access: MemoryGrantSchema.nullable(),
  }).superRefine((r, ctx) => {
    if ((r.boardId === undefined) === (r.artifactId === undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['boardId'],
        message: 'Give exactly one of boardId or artifactId',
      });
  }),
  res: OkResSchema,
});

// ─── reads (for callers that do not read Firestore directly) ─────────────────

export const memoryList = defineCommand({
  name: 'memoryList',
  source: 'app',
  scopes: ['memory:read', 'memory:write'],
  permission:
    'Anyone: answers the memories the caller reaches (memoryReach ≠ null). With boardId: only those granted to that board, and the caller must be on it. With artifactId: only those granted to that artifact that the caller reaches (the driver broker, §H).',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    boardId: BoardIdSchema.optional(),
    artifactId: ArtifactIdSchema.optional(),
    includeArchived: z.boolean().optional(),
  }),
  res: z.object({ memories: z.array(MemoryOutSchema) }),
});

export const memoryTree = defineCommand({
  name: 'memoryTree',
  source: 'app',
  scopes: ['memory:read', 'memory:write'],
  permission: 'Read reach. Every node under `path` (default: the whole memory), sorted by path.',
  errors: ['not_found', 'invalid'],
  req: req({
    memoryId: MemoryIdSchema,
    path: PathInput.optional(),
    /** Only the direct children of `path`, not the whole subtree. */
    shallow: z.boolean().optional(),
  }),
  res: z.object({ nodes: z.array(MemoryNodeOutSchema), truncated: z.boolean() }),
});

export const memoryFileRead = defineCommand({
  name: 'memoryFileRead',
  source: 'app',
  scopes: ['memory:read', 'memory:write'],
  permission:
    "Read reach. A text file comes back as `text` (at most MEMORY_READ_TEXT_MAX_BYTES; `truncated` says if there was more). Any file also gets a short-lived `url` (and same-origin `bytesUrl`) — the file door's.",
  errors: ['not_found', 'invalid'],
  req: req({ memoryId: MemoryIdSchema, ...nodeTarget, asText: z.boolean().optional() }).superRefine(
    exactlyOne,
  ),
  res: z.object({
    node: MemoryNodeOutSchema,
    text: z.string().nullable(),
    truncated: z.boolean(),
    url: z.string(),
    bytesUrl: z.string(),
    expiresAt: MillisSchema,
  }),
});

// ─── nodes ───────────────────────────────────────────────────────────────────

/**
 * Create or replace a file INLINE (≤ MEMORY_INLINE_MAX_BYTES): exactly one of
 * text / content_base64. Target: an existing `nodeId`, or a `path` (created
 * with its parents, or replaced if it is already a file). A new version is a
 * new object (D-M2). `expectedFileId` makes a save conditional: a 409 if the
 * file changed since the editor opened it.
 */
export const memoryFileWrite = defineCommand({
  name: 'memoryFileWrite',
  source: 'app',
  scopes: ['memory:write'],
  permission: 'Write reach (memoryReach: editor/owner, or editor+ on a board granted write).',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict', 'too_large'],
  req: req({
    memoryId: MemoryIdSchema,
    ...nodeTarget,
    text: z.string().optional(),
    content_base64: z.string().optional(),
    mime: z.string().max(255).optional(),
    expectedFileId: z.string().max(64).nullable().optional(),
  }).superRefine((r, ctx) => {
    exactlyOne(r, ctx);
    if ((r.text === undefined) === (r.content_base64 === undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'Give exactly one of text or content_base64',
      });
  }),
  res: z.object({ nodeId: MemoryNodeIdSchema, fileId: z.string(), path: z.string() }),
});

/**
 * Register a file the APP uploaded straight to Storage at
 * memoryStoragePath(memoryId, fileId, name). The handler checks the object
 * exists under this memory's prefix and takes size / content type from its
 * metadata. Target as memoryFileWrite (a path creates or replaces).
 */
export const memoryFilePut = defineCommand({
  name: 'memoryFilePut',
  source: 'app',
  scopes: ['memory:write'],
  permission: 'Write reach.',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict', 'too_large'],
  req: req({
    memoryId: MemoryIdSchema,
    ...nodeTarget,
    storagePath: StoragePathSchema,
    expectedFileId: z.string().max(64).nullable().optional(),
  }).superRefine(exactlyOne),
  res: z.object({ nodeId: MemoryNodeIdSchema, fileId: z.string(), path: z.string() }),
});

export const memoryFolderCreate = defineCommand({
  name: 'memoryFolderCreate',
  source: 'app',
  scopes: ['memory:write'],
  permission:
    'Write reach. Creates missing parents; an existing folder at the path is not an error.',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({ memoryId: MemoryIdSchema, path: PathInput }),
  res: z.object({ nodeId: MemoryNodeIdSchema, path: z.string() }),
});

/**
 * §J: a board's default for ticket attachments — which memory (granted `write`
 * to the board) and the path template. null clears it.
 */
export const boardAttachMemorySet = defineCommand({
  name: 'boardAttachMemorySet',
  source: 'app',
  scopes: ['board:admin', 'boards:admin'],
  permission:
    'can(admin) on the board. The memory must be granted `write` to the board (board settings › Memory). Never an agent.',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({ boardId: BoardIdSchema, attachMemory: BoardAttachMemorySchema.nullable() }),
  res: OkResSchema,
});

/** Rename and/or move a node (a folder takes its whole subtree along). */
export const memoryMove = defineCommand({
  name: 'memoryMove',
  source: 'app',
  scopes: ['memory:write'],
  permission:
    "Write reach. `toPath` is the node's NEW full path; its parent folders are created. A 409 if something is already there, or if a folder would move inside itself.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({ memoryId: MemoryIdSchema, ...nodeTarget, toPath: PathInput }).superRefine(exactlyOne),
  res: z.object({ nodeId: MemoryNodeIdSchema, path: z.string() }),
});

/** Delete nodes; a folder goes with everything under it. Storage objects are deleted after the commit. */
export const memoryNodeDelete = defineCommand({
  name: 'memoryNodeDelete',
  source: 'app',
  scopes: ['memory:write'],
  permission: 'Write reach.',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    memoryId: MemoryIdSchema,
    paths: z.array(PathInput).max(100).optional(),
    nodeIds: z.array(MemoryNodeIdSchema).max(100).optional(),
  }).superRefine((r, ctx) => {
    if (!r.paths?.length && !r.nodeIds?.length)
      ctx.addIssue({ code: 'custom', path: ['paths'], message: 'Give paths or nodeIds' });
  }),
  res: z.object({ deleted: z.number().int().nonnegative() }),
});
