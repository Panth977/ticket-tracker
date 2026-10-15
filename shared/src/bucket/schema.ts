/**
 * BUCKET (docs/plan/bucket.html) — the stored shapes.
 *
 *   buckets/{bucketId}                   BucketSchema
 *   buckets/{bucketId}/nodes/{nodeId}    BucketNodeSchema (a folder or a file)
 *   Storage buckets/{bucketId}/{fileId}/{fileName}   the bytes, by file id
 *
 * A bucket is not a board: its people are its own (§B). Boards and artifacts
 * reach it only through a GRANT stored here (§D), and bucketReach() is the one
 * answer to "what may this principal do".
 */
import { z } from 'zod';
import { DESCRIPTION_MAX, IndicatorSchema } from '../types/indicator.js';
import { ArtifactIdSchema } from '../artifacts/schema.js';
import {
  BoardIdSchema,
  MillisSchema,
  PrincipalIdSchema,
  UidSchema,
  type BoardRole,
} from '../types/index.js';

export const BUCKET_ROLES = ['owner', 'editor', 'viewer'] as const;
export const BucketRoleSchema = z.enum(BUCKET_ROLES);
export type BucketRole = z.infer<typeof BucketRoleSchema>;
/** A role that may be GIVEN by sharing — the owner is set at create. */
export const BucketShareRoleSchema = z.enum(['editor', 'viewer']);
export type BucketShareRole = z.infer<typeof BucketShareRoleSchema>;

/** §D: what a board or an artifact was granted. A ceiling, never a floor. */
export const BUCKET_GRANTS = ['read', 'write'] as const;
export const BucketGrantSchema = z.enum(BUCKET_GRANTS);
export type BucketGrant = z.infer<typeof BucketGrantSchema>;

export const BucketIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Bucket id');
export type BucketId = z.infer<typeof BucketIdSchema>;
export const BucketNodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Node id');
export type BucketNodeId = z.infer<typeof BucketNodeIdSchema>;
export const BucketFileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'File id');

// ─── limits (§C) ──────────────────────────────────────────────────────────────
export const BUCKET_NAME_MAX = 80;
/** indicators.html: the one description limit. */
export const BUCKET_DESCRIPTION_MAX = DESCRIPTION_MAX;
export const BUCKET_NODE_NAME_MAX = 255;
export const BUCKET_PATH_MAX = 1024;
export const BUCKET_DEPTH_MAX = 32;
export const BUCKET_NODES_MAX = 10_000;
/** One file uploaded by the app straight to Storage. */
export const BUCKET_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
/** One file written inline through a command (API / MCP / driver / code mode). */
export const BUCKET_INLINE_MAX_BYTES = 10 * 1024 * 1024;
/** bucketFileRead returns at most this much text; more is truncated. */
export const BUCKET_READ_TEXT_MAX_BYTES = 1024 * 1024;
export const BUCKETS_OWNED_MAX = 100;
export const BUCKET_GRANTS_MAX = 20;

/**
 * One path segment: 1–255 characters, no '/', not '.' or '..', no control
 * characters. Leading / trailing spaces are trimmed by the commands.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f]/;
export const BucketNodeNameSchema = z
  .string()
  .min(1)
  .max(BUCKET_NODE_NAME_MAX)
  .refine((n) => !n.includes('/') && n !== '.' && n !== '..' && !CONTROL.test(n), {
    message: "A name cannot contain '/' or control characters, or be '.' / '..'",
  });

/**
 * A path inside a bucket: segments joined by '/', no leading or trailing '/'.
 * '' is the root (a folder only). normalizeBucketPath() makes one from what a
 * person or an agent typed.
 */
export const BucketPathSchema = z
  .string()
  .max(BUCKET_PATH_MAX)
  .refine((p) => p === '' || splitBucketPath(p) !== null, {
    message: 'Not a valid path (no empty segments, ., .., or more than 32 levels)',
  });

export const BucketSchema = z.object({
  name: z.string().min(1).max(BUCKET_NAME_MAX),
  description: z.string().max(BUCKET_DESCRIPTION_MAX).nullable(),
  /** LEGACY (indicators.html): one typed emoji, or null for 🧠. Read through indicatorOf(). */
  icon: z.string().max(16).nullable(),
  /** indicators.html: what the sidebar, dropdowns and cards draw. */
  indicator: IndicatorSchema.optional(),
  ownerUid: UidSchema,
  /** Every PERSON with a role, the owner included. Rules read this. */
  access: z.record(UidSchema, BucketRoleSchema),
  /** The keys of `access`, derived (a list query needs array-contains). */
  memberUids: z.array(UidSchema),
  /** §D: boards that may use it. */
  boards: z.record(BoardIdSchema, BucketGrantSchema),
  /** §D: artifacts whose page may use it (through BackendDriver.bucket). */
  artifacts: z.record(ArtifactIdSchema, BucketGrantSchema),
  /** The keys of `boards`, derived — where('boardIds', 'array-contains', b). */
  boardIds: z.array(BoardIdSchema),
  /** Counters kept by the node commands. */
  stats: z.object({
    files: z.number().int().nonnegative(),
    folders: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  archivedAt: MillisSchema.nullable(),
  createdAt: MillisSchema,
  updatedAt: MillisSchema,
  /** Set by bucketDelete; the queued job removes everything, this document last. */
  deletingAt: MillisSchema.nullable().optional(),
});
export type Bucket = z.infer<typeof BucketSchema>;
export type BucketWithId = Bucket & { id: string };

/** The current version of a file node. */
export const BucketFileSchema = z.object({
  fileId: BucketFileIdSchema,
  /** buckets/{bucketId}/{fileId}/{fileName} — never a URL. */
  storagePath: z.string().min(1).max(1024),
  mime: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  /** Images, when known (for layout before load). */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type BucketFile = z.infer<typeof BucketFileSchema>;

export const BUCKET_NODE_KINDS = ['folder', 'file'] as const;
export const BucketNodeKindSchema = z.enum(BUCKET_NODE_KINDS);
export type BucketNodeKind = z.infer<typeof BucketNodeKindSchema>;

export const BucketNodeSchema = z.object({
  kind: BucketNodeKindSchema,
  /** null = at the root. */
  parentId: BucketNodeIdSchema.nullable(),
  name: BucketNodeNameSchema,
  /** The full path, denormalized (D-M1); rewritten for a whole subtree on move. */
  path: BucketPathSchema,
  /** Files only. */
  file: BucketFileSchema.nullable(),
  createdAt: MillisSchema,
  createdBy: PrincipalIdSchema,
  updatedAt: MillisSchema,
  updatedBy: PrincipalIdSchema,
});
export type BucketNode = z.infer<typeof BucketNodeSchema>;
export type BucketNodeWithId = BucketNode & { id: string };

/** §E: a ticket's pointer at a bucket file. */
export const BucketRefSchema = z.object({
  bucketId: BucketIdSchema,
  nodeId: BucketNodeIdSchema,
});
export type BucketRef = z.infer<typeof BucketRefSchema>;
/** At most this many bucket refs in one message / ticket write. */
export const BUCKET_REFS_MAX = 20;

// ─── paths inside a bucket ───────────────────────────────────────────────────

/** 'a/b/c' → ['a','b','c']; '' → []; null when invalid. */
export function splitBucketPath(p: string): string[] | null {
  if (p === '') return [];
  if (p.length > BUCKET_PATH_MAX) return null;
  const parts = p.split('/');
  if (parts.length > BUCKET_DEPTH_MAX) return null;
  for (const s of parts) if (!BucketNodeNameSchema.safeParse(s).success) return null;
  return parts;
}

/**
 * What someone typed → a canonical path: backslashes to '/', leading and
 * trailing slashes and spaces trimmed per segment, runs of '/' collapsed.
 * Returns null when what is left is not a valid path.
 */
export function normalizeBucketPath(input: string): string | null {
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const p = parts.join('/');
  return splitBucketPath(p) === null ? null : p;
}

export const bucketParentPath = (p: string): string =>
  p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
export const bucketBaseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
export const joinBucketPath = (parent: string, name: string): string =>
  parent === '' ? name : `${parent}/${name}`;
/** Is `p` equal to or inside `folder`? ('' contains everything.) */
export const bucketPathWithin = (p: string, folder: string): boolean =>
  folder === '' || p === folder || p.startsWith(folder + '/');

// ─── who may do what (§B, §D) ────────────────────────────────────────────────

/**
 * What a principal may do in one bucket:
 *   'manage'  owner: share, grant, rename, delete the bucket
 *   'write'   upload, edit, folders, move, delete nodes
 *   'read'    browse, preview, download, attach to a granted board's tickets
 *   null      nothing (and the bucket answers 404)
 */
export type BucketReach = 'manage' | 'write' | 'read' | null;

/**
 * THE ONE ANSWER (§D). `role` is the principal's own role on the bucket (a
 * person; agents never have one). `boardRoles` are the principal's roles on
 * boards — only the GRANTED ones matter. A board 'read' grant gives every
 * member 'read'; a 'write' grant gives editors and admins 'write'. The best
 * of all routes wins. An archived bucket is read-only to everyone but the
 * owner's manage (which may restore it); a deleting one reaches nobody.
 */
export function bucketReach(
  m: Pick<Bucket, 'access' | 'boards' | 'archivedAt'> & { deletingAt?: number | null | undefined },
  who: {
    uid?: string | null | undefined;
    boardRoles?: ReadonlyMap<string, BoardRole | null | undefined> | undefined;
  },
): BucketReach {
  if (m.deletingAt) return null;
  const rank = { read: 1, write: 2, manage: 3 } as const;
  let best: Exclude<BucketReach, null> | null = null;
  const take = (r: Exclude<BucketReach, null>) => {
    if (!best || rank[r] > rank[best]) best = r;
  };
  const role = who.uid ? m.access[who.uid] : undefined;
  if (role === 'owner') take('manage');
  else if (role === 'editor') take('write');
  else if (role === 'viewer') take('read');
  for (const [boardId, grant] of Object.entries(m.boards ?? {})) {
    const br = who.boardRoles?.get(boardId);
    if (!br) continue;
    if (grant === 'write' && (br === 'admin' || br === 'editor')) take('write');
    else take('read');
  }
  if (best === 'write' && m.archivedAt != null) return 'read';
  return best;
}

export const bucketCan = {
  read: (r: BucketReach): boolean => r !== null,
  write: (r: BucketReach): boolean => r === 'write' || r === 'manage',
  manage: (r: BucketReach): boolean => r === 'manage',
};

/**
 * §D for an artifact's page: the GRANT is the ceiling, the VIEWER's own reach
 * the floor. null = the page may not touch this bucket.
 */
export function bucketArtifactReach(
  m: Pick<Bucket, 'artifacts'>,
  artifactId: string,
  viewer: BucketReach,
): 'read' | 'write' | null {
  const grant = m.artifacts?.[artifactId];
  if (!grant || !viewer) return null;
  return grant === 'write' && bucketCan.write(viewer) ? 'write' : 'read';
}

/** The emoji the sidebar shows. */
export const bucketGlyph = (m: Pick<Bucket, 'icon'>): string => m.icon || '🧠';

// ─── previews ────────────────────────────────────────────────────────────────

export const BUCKET_PREVIEW_KINDS = [
  'markdown',
  'text',
  'image',
  'video',
  'audio',
  'pdf',
  'other',
] as const;
export type BucketPreviewKind = (typeof BUCKET_PREVIEW_KINDS)[number];

const TEXT_EXT =
  /\.(txt|md|markdown|mdx|json|jsonc|ya?ml|toml|ini|env|csv|tsv|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|svelte|vue|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|gql|proto|dockerfile|gitignore|log|svg)$/i;

/** How the app previews a file, from its mime and name. */
export function bucketPreviewKind(name: string, mime: string): BucketPreviewKind {
  const n = name.toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(n) || mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (isBucketTextFile(name, mime)) return 'text';
  return 'other';
}

/** May Code mode show and edit this file as text? */
export function isBucketTextFile(name: string, mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    /^application\/(json|xml|javascript|x-sh|x-yaml|yaml|toml|sql|graphql)/.test(mime) ||
    mime === 'image/svg+xml' ||
    TEXT_EXT.test(name) ||
    /^(dockerfile|makefile|readme|license)$/i.test(name)
  );
}
