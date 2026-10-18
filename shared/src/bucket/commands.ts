/**
 * BUCKET (docs/plan/bucket.html §G) — the commands. Every door (the app's
 * /api, /v1 REST, MCP) calls these.
 *
 * Tokens: `bucket:read` / `bucket:write`. An account token or an OAuth grant
 * reaches what its person reaches; an agent token reaches only buckets
 * granted to a board the agent is on (§B, D-M4). bucketReach() decides.
 *
 * NODES ARE NAMED BY PATH or by id: exactly one of `path` / `nodeId` where a
 * node is the target. Writing a path creates its missing parent folders.
 */
import { z } from 'zod';
import { OwnerRefSchema } from '../org/owner.js';
import { ArtifactIdSchema } from '../artifacts/schema.js';
import { defineCommand, OkResSchema, req } from '../commands/define.js';
import { EmailInputSchema } from '../config.js';
import { BoardIdSchema, MillisSchema, StoragePathSchema } from '../types/index.js';
import {
  BUCKET_DESCRIPTION_MAX,
  BUCKET_NAME_MAX,
  BucketGrantSchema,
  BucketIdSchema,
  BucketNodeIdSchema,
  BucketNodeKindSchema,
  BucketPathSchema,
  BucketShareRoleSchema,
  BucketFileSchema,
} from './schema.js';
import { BoardAttachBucketSchema } from './attach.js';
import { BucketStorageInputSchema, BucketStorageKindSchema, DriveStatusSchema } from './drive.js';
import { IndicatorSchema } from '../types/indicator.js';

const Name = z.string().trim().min(1).max(BUCKET_NAME_MAX);
const Description = z.string().trim().max(BUCKET_DESCRIPTION_MAX);
const Icon = z.string().max(16);
/** What a caller may type as a path: normalized by the handler (normalizeBucketPath). */
const PathInput = z.string().max(1024);

/** A node, by path or by id — exactly one. */
const nodeTarget = {
  path: PathInput.optional(),
  nodeId: BucketNodeIdSchema.optional(),
};
function exactlyOne(
  r: { path?: string | undefined; nodeId?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if ((r.path === undefined) === (r.nodeId === undefined))
    ctx.addIssue({ code: 'custom', path: ['path'], message: 'Give exactly one of path or nodeId' });
}

/** A node as the API returns it (the stored node, flattened, with its id). */
export const BucketNodeOutSchema = z.object({
  id: BucketNodeIdSchema,
  kind: BucketNodeKindSchema,
  parentId: BucketNodeIdSchema.nullable(),
  name: z.string(),
  path: BucketPathSchema,
  file: BucketFileSchema.omit({ storagePath: true }).nullable(),
  updatedAt: MillisSchema,
});
export type BucketNodeOut = z.infer<typeof BucketNodeOutSchema>;

/** A bucket as the API returns it, with what the CALLER may do there. */
export const BucketOutSchema = z.object({
  id: BucketIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  /** LEGACY: the typed emoji, if any. Read `indicator`. */
  icon: z.string().nullable(),
  /** indicators.html: always present (read through indicatorOf for old buckets). */
  indicator: IndicatorSchema,
  reach: z.enum(['manage', 'write', 'read']),
  archived: z.boolean(),
  stats: z.object({ files: z.number(), folders: z.number(), bytes: z.number() }),
  updatedAt: MillisSchema,
  /** §K: where its files live; for Drive, the folder's name and whose Drive. */
  storage: z
    .object({
      kind: BucketStorageKindSchema,
      folderName: z.string().nullable(),
      email: z.string().nullable(),
    })
    .optional(),
  /**
   * bucketList({ boardId }) only: THAT board's grant (§D). It tells the attach
   * dialog which buckets a ticket file may go into (§J: 'write') — which the
   * caller's own `reach` cannot (a commenter reads either way).
   */
  boardGrant: BucketGrantSchema.optional(),
});
export type BucketOut = z.infer<typeof BucketOutSchema>;

// ─── the bucket ──────────────────────────────────────────────────────────────

export const bucketCreate = defineCommand({
  name: 'bucketCreate',
  source: 'app',
  scopes: ['bucket:write'],
  permission:
    'Any allowed person, or an account token / OAuth grant with bucket:write; they become its owner. Never an agent token (an agent reaches bucket through boards, D-M4).',
  errors: ['forbidden', 'invalid', 'conflict'],
  req: req({
    name: Name,
    description: Description.nullable().optional(),
    /** LEGACY (old clients): one emoji. Prefer `indicator`. */
    icon: Icon.nullable().optional(),
    /** indicators.html: the bucket's mark (colour, icon, emoji or uploaded image). */
    indicator: IndicatorSchema.optional(),
    /** §AC: who owns it — you (default) or an org you belong to. */
    owner: OwnerRefSchema.optional(),
    /**
     * §K: where its files live — managed (default) or a folder in YOUR Google
     * Drive (connect it first: driveConnect). Fixed for the bucket's life.
     */
    storage: BucketStorageInputSchema.optional(),
  }),
  res: z.object({ bucketId: BucketIdSchema }),
});

export const bucketUpdate = defineCommand({
  name: 'bucketUpdate',
  source: 'app',
  scopes: ['bucket:write'],
  permission: 'Owner only (404 to anyone who cannot reach it, 403 to editors/viewers).',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    bucketId: BucketIdSchema,
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

export const bucketDelete = defineCommand({
  name: 'bucketDelete',
  source: 'app',
  scopes: ['bucket:write'],
  permission:
    'Owner only. Empties access and grants at once (nobody reaches it from then on) and queues the job that removes the files, the nodes and then the document. Tickets that point at its files keep a row that reads as gone.',
  errors: ['not_found', 'forbidden'],
  req: req({ bucketId: BucketIdSchema }),
  res: OkResSchema,
});

export const bucketShare = defineCommand({
  name: 'bucketShare',
  source: 'app',
  scopes: ['bucket:write'],
  permission:
    "Owner only — never an agent. A person's role by email ('editor' | 'viewer'; null removes). An address with no account yet → an invite (invites/ with bucketId). The owner's own role cannot be changed.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({
    bucketId: BucketIdSchema,
    email: EmailInputSchema,
    role: BucketShareRoleSchema.nullable(),
  }),
  res: z.object({ ok: z.literal(true), invited: z.boolean() }),
});

/**
 * §D — let a board or an artifact use this bucket, or stop it. A ceiling: what
 * a member then does is bounded by their own role (bucketReach).
 */
export const bucketGrantSet = defineCommand({
  name: 'bucketGrantSet',
  source: 'app',
  scopes: ['bucket:write'],
  permission:
    "Granting: the bucket's OWNER, who must also be an admin of the board (or the owner of the artifact). Removing (access null): the bucket's owner, OR an admin of that board, OR the owner of that artifact — either side may end it. Exactly one of boardId / artifactId. Never an agent.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({
    bucketId: BucketIdSchema,
    boardId: BoardIdSchema.optional(),
    artifactId: ArtifactIdSchema.optional(),
    access: BucketGrantSchema.nullable(),
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

export const bucketList = defineCommand({
  name: 'bucketList',
  source: 'app',
  scopes: ['bucket:read', 'bucket:write'],
  permission:
    'Anyone: answers the buckets the caller reaches (bucketReach ≠ null). With boardId: only those granted to that board, and the caller must be on it. With artifactId: only those granted to that artifact that the caller reaches (the driver broker, §H).',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    boardId: BoardIdSchema.optional(),
    artifactId: ArtifactIdSchema.optional(),
    includeArchived: z.boolean().optional(),
  }),
  res: z.object({ buckets: z.array(BucketOutSchema) }),
});

export const bucketTree = defineCommand({
  name: 'bucketTree',
  source: 'app',
  scopes: ['bucket:read', 'bucket:write'],
  permission: 'Read reach. Every node under `path` (default: the whole bucket), sorted by path.',
  errors: ['not_found', 'invalid'],
  req: req({
    bucketId: BucketIdSchema,
    path: PathInput.optional(),
    /** Only the direct children of `path`, not the whole subtree. */
    shallow: z.boolean().optional(),
  }),
  res: z.object({ nodes: z.array(BucketNodeOutSchema), truncated: z.boolean() }),
});

export const bucketFileRead = defineCommand({
  name: 'bucketFileRead',
  source: 'app',
  scopes: ['bucket:read', 'bucket:write'],
  permission:
    "Read reach. A text file comes back as `text` (at most BUCKET_READ_TEXT_MAX_BYTES; `truncated` says if there was more). Any file also gets a short-lived `url` (and same-origin `bytesUrl`) — the file door's.",
  errors: ['not_found', 'invalid'],
  req: req({ bucketId: BucketIdSchema, ...nodeTarget, asText: z.boolean().optional() }).superRefine(
    exactlyOne,
  ),
  res: z.object({
    node: BucketNodeOutSchema,
    text: z.string().nullable(),
    truncated: z.boolean(),
    url: z.string(),
    bytesUrl: z.string(),
    expiresAt: MillisSchema,
  }),
});

// ─── nodes ───────────────────────────────────────────────────────────────────

/**
 * Create or replace a file INLINE (≤ BUCKET_INLINE_MAX_BYTES): exactly one of
 * text / content_base64. Target: an existing `nodeId`, or a `path` (created
 * with its parents, or replaced if it is already a file). A new version is a
 * new object (D-M2). `expectedFileId` makes a save conditional: a 409 if the
 * file changed since the editor opened it.
 */
export const bucketFileWrite = defineCommand({
  name: 'bucketFileWrite',
  source: 'app',
  scopes: ['bucket:write'],
  permission: 'Write reach (bucketReach: editor/owner, or editor+ on a board granted write).',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict', 'too_large'],
  req: req({
    bucketId: BucketIdSchema,
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
  res: z.object({ nodeId: BucketNodeIdSchema, fileId: z.string(), path: z.string() }),
});

/**
 * Register a file the APP uploaded straight to Storage at
 * bucketStoragePath(bucketId, fileId, name). The handler checks the object
 * exists under this bucket's prefix and takes size / content type from its
 * metadata. Target as bucketFileWrite (a path creates or replaces).
 */
export const bucketFilePut = defineCommand({
  name: 'bucketFilePut',
  source: 'app',
  scopes: ['bucket:write'],
  permission: 'Write reach.',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict', 'too_large'],
  req: req({
    bucketId: BucketIdSchema,
    ...nodeTarget,
    storagePath: StoragePathSchema,
    expectedFileId: z.string().max(64).nullable().optional(),
  }).superRefine(exactlyOne),
  res: z.object({ nodeId: BucketNodeIdSchema, fileId: z.string(), path: z.string() }),
});

export const bucketFolderCreate = defineCommand({
  name: 'bucketFolderCreate',
  source: 'app',
  scopes: ['bucket:write'],
  permission:
    'Write reach. Creates missing parents; an existing folder at the path is not an error.',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({ bucketId: BucketIdSchema, path: PathInput }),
  res: z.object({ nodeId: BucketNodeIdSchema, path: z.string() }),
});

/**
 * §J: a board's default for ticket attachments — which bucket (granted `write`
 * to the board) and the path template. null clears it.
 */
export const boardAttachBucketSet = defineCommand({
  name: 'boardAttachBucketSet',
  source: 'app',
  scopes: ['board:admin', 'boards:admin'],
  permission:
    'can(admin) on the board. The bucket must be granted `write` to the board (board settings › Bucket). Never an agent.',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({ boardId: BoardIdSchema, attachBucket: BoardAttachBucketSchema.nullable() }),
  res: OkResSchema,
});

/** Rename and/or move a node (a folder takes its whole subtree along). */
export const bucketMove = defineCommand({
  name: 'bucketMove',
  source: 'app',
  scopes: ['bucket:write'],
  permission:
    "Write reach. `toPath` is the node's NEW full path; its parent folders are created. A 409 if something is already there, or if a folder would move inside itself.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({ bucketId: BucketIdSchema, ...nodeTarget, toPath: PathInput }).superRefine(exactlyOne),
  res: z.object({ nodeId: BucketNodeIdSchema, path: z.string() }),
});

/** Delete nodes; a folder goes with everything under it. Storage objects are deleted after the commit. */
export const bucketNodeDelete = defineCommand({
  name: 'bucketNodeDelete',
  source: 'app',
  scopes: ['bucket:write'],
  permission: 'Write reach.',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    bucketId: BucketIdSchema,
    paths: z.array(PathInput).max(100).optional(),
    nodeIds: z.array(BucketNodeIdSchema).max(100).optional(),
  }).superRefine((r, ctx) => {
    if (!r.paths?.length && !r.nodeIds?.length)
      ctx.addIssue({ code: 'custom', path: ['paths'], message: 'Give paths or nodeIds' });
  }),
  res: z.object({ deleted: z.number().int().nonnegative() }),
});

// ─── Google Drive (§K) ───────────────────────────────────────────────────────

/**
 * §K4: open an upload the browser sends straight to Google Drive (a Drive
 * bucket only — nothing goes through our object store). `put`: the bucket's
 * own file at path / nodeId (write reach), confirmed after with bucketFilePut.
 * `attach`: a ticket file for `boardId` (the bucket granted write there),
 * named in bucketUploads after. PUT the whole body to `uploadUrl`.
 */
export const bucketDriveUpload = defineCommand({
  name: 'bucketDriveUpload',
  source: 'extra',
  permission:
    'put: write reach. attach: may upload on the board, and the bucket is granted write to it. The bucket must be a Drive bucket.',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict', 'too_large', 'unavailable'],
  req: req({
    bucketId: BucketIdSchema,
    purpose: z.enum(['put', 'attach']),
    path: PathInput.optional(),
    nodeId: BucketNodeIdSchema.optional(),
    boardId: BoardIdSchema.optional(),
    name: z.string().min(1).max(255),
    mime: z.string().max(255),
    size: z.number().int().nonnegative(),
    expectedFileId: z.string().max(64).nullable().optional(),
    /** The app's origin: Drive answers the browser's PUT with CORS for it. */
    origin: z.string().url().max(255).optional(),
  }),
  res: z.object({
    uploadUrl: z.string(),
    driveId: z.string(),
    path: z.string(),
    storagePath: z.string(),
    expiresAt: MillisSchema,
  }),
});

/** Is my Google Drive connected (and can this server talk to Drive at all)? */
export const driveStatus = defineCommand({
  name: 'driveStatus',
  source: 'extra',
  permission: 'Any signed-in person, about their own connection. Never an agent.',
  errors: ['forbidden'],
  req: req({}),
  res: DriveStatusSchema,
});

/**
 * Start connecting my Google Drive: the consent page's URL (offline access,
 * scope drive.file). Google sends the person back to /integrations/drive/callback,
 * which stores the connection and returns to `returnTo` (an app path).
 */
export const driveConnect = defineCommand({
  name: 'driveConnect',
  source: 'extra',
  permission: 'Any signed-in person, for themselves. Never an agent or a token.',
  errors: ['forbidden', 'unavailable'],
  req: req({ returnTo: z.string().max(512).startsWith('/').optional() }),
  res: z.object({ url: z.string() }),
});

/**
 * Forget my Drive connection (and revoke it at Google). Drive buckets that use
 * it stay — their files are still in Drive — but cannot be opened until I
 * connect again.
 */
export const driveDisconnect = defineCommand({
  name: 'driveDisconnect',
  source: 'extra',
  permission: 'Any signed-in person, their own connection. Never an agent or a token.',
  errors: ['forbidden'],
  req: req({}),
  res: OkResSchema,
});

/**
 * A short-lived access token for Google's folder picker, in the browser of the
 * person whose Drive it is (scope drive.file only: the picker GRANTS the app
 * the folder picked). With the picker's public API key and app id.
 */
export const drivePickerToken = defineCommand({
  name: 'drivePickerToken',
  source: 'extra',
  permission: 'Any signed-in person with a connected Drive, for their own Drive. Never a token.',
  errors: ['forbidden', 'conflict', 'unavailable'],
  req: req({}),
  res: z.object({
    accessToken: z.string(),
    apiKey: z.string(),
    appId: z.string(),
    expiresAt: MillisSchema,
  }),
});
