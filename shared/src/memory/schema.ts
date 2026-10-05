/**
 * MEMORY (docs/plan/memory.html) — the stored shapes.
 *
 *   memories/{memoryId}                   MemorySchema
 *   memories/{memoryId}/nodes/{nodeId}    MemoryNodeSchema (a folder or a file)
 *   Storage memories/{memoryId}/{fileId}/{fileName}   the bytes, by file id
 *
 * A memory is not a board: its people are its own (§B). Boards and artifacts
 * reach it only through a GRANT stored here (§D), and memoryReach() is the one
 * answer to "what may this principal do".
 */
import { z } from 'zod';
import { ArtifactIdSchema } from '../artifacts/schema.js';
import {
  BoardIdSchema,
  MillisSchema,
  PrincipalIdSchema,
  UidSchema,
  type BoardRole,
} from '../types/index.js';

export const MEMORY_ROLES = ['owner', 'editor', 'viewer'] as const;
export const MemoryRoleSchema = z.enum(MEMORY_ROLES);
export type MemoryRole = z.infer<typeof MemoryRoleSchema>;
/** A role that may be GIVEN by sharing — the owner is set at create. */
export const MemoryShareRoleSchema = z.enum(['editor', 'viewer']);
export type MemoryShareRole = z.infer<typeof MemoryShareRoleSchema>;

/** §D: what a board or an artifact was granted. A ceiling, never a floor. */
export const MEMORY_GRANTS = ['read', 'write'] as const;
export const MemoryGrantSchema = z.enum(MEMORY_GRANTS);
export type MemoryGrant = z.infer<typeof MemoryGrantSchema>;

export const MemoryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Memory id');
export type MemoryId = z.infer<typeof MemoryIdSchema>;
export const MemoryNodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Node id');
export type MemoryNodeId = z.infer<typeof MemoryNodeIdSchema>;
export const MemoryFileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'File id');

// ─── limits (§C) ──────────────────────────────────────────────────────────────
export const MEMORY_NAME_MAX = 80;
export const MEMORY_DESCRIPTION_MAX = 500;
export const MEMORY_NODE_NAME_MAX = 255;
export const MEMORY_PATH_MAX = 1024;
export const MEMORY_DEPTH_MAX = 32;
export const MEMORY_NODES_MAX = 10_000;
/** One file uploaded by the app straight to Storage. */
export const MEMORY_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
/** One file written inline through a command (API / MCP / driver / code mode). */
export const MEMORY_INLINE_MAX_BYTES = 10 * 1024 * 1024;
/** memoryFileRead returns at most this much text; more is truncated. */
export const MEMORY_READ_TEXT_MAX_BYTES = 1024 * 1024;
export const MEMORIES_OWNED_MAX = 100;
export const MEMORY_GRANTS_MAX = 20;

/**
 * One path segment: 1–255 characters, no '/', not '.' or '..', no control
 * characters. Leading / trailing spaces are trimmed by the commands.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f]/;
export const MemoryNodeNameSchema = z
  .string()
  .min(1)
  .max(MEMORY_NODE_NAME_MAX)
  .refine((n) => !n.includes('/') && n !== '.' && n !== '..' && !CONTROL.test(n), {
    message: "A name cannot contain '/' or control characters, or be '.' / '..'",
  });

/**
 * A path inside a memory: segments joined by '/', no leading or trailing '/'.
 * '' is the root (a folder only). normalizeMemoryPath() makes one from what a
 * person or an agent typed.
 */
export const MemoryPathSchema = z
  .string()
  .max(MEMORY_PATH_MAX)
  .refine((p) => p === '' || splitMemoryPath(p) !== null, {
    message: 'Not a valid path (no empty segments, ., .., or more than 32 levels)',
  });

export const MemorySchema = z.object({
  name: z.string().min(1).max(MEMORY_NAME_MAX),
  description: z.string().max(MEMORY_DESCRIPTION_MAX).nullable(),
  /** One emoji, or null for the default 🧠. */
  icon: z.string().max(16).nullable(),
  ownerUid: UidSchema,
  /** Every PERSON with a role, the owner included. Rules read this. */
  access: z.record(UidSchema, MemoryRoleSchema),
  /** The keys of `access`, derived (a list query needs array-contains). */
  memberUids: z.array(UidSchema),
  /** §D: boards that may use it. */
  boards: z.record(BoardIdSchema, MemoryGrantSchema),
  /** §D: artifacts whose page may use it (through BackendDriver.memory). */
  artifacts: z.record(ArtifactIdSchema, MemoryGrantSchema),
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
  /** Set by memoryDelete; the queued job removes everything, this document last. */
  deletingAt: MillisSchema.nullable().optional(),
});
export type Memory = z.infer<typeof MemorySchema>;
export type MemoryWithId = Memory & { id: string };

/** The current version of a file node. */
export const MemoryFileSchema = z.object({
  fileId: MemoryFileIdSchema,
  /** memories/{memoryId}/{fileId}/{fileName} — never a URL. */
  storagePath: z.string().min(1).max(1024),
  mime: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  /** Images, when known (for layout before load). */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

export const MEMORY_NODE_KINDS = ['folder', 'file'] as const;
export const MemoryNodeKindSchema = z.enum(MEMORY_NODE_KINDS);
export type MemoryNodeKind = z.infer<typeof MemoryNodeKindSchema>;

export const MemoryNodeSchema = z.object({
  kind: MemoryNodeKindSchema,
  /** null = at the root. */
  parentId: MemoryNodeIdSchema.nullable(),
  name: MemoryNodeNameSchema,
  /** The full path, denormalized (D-M1); rewritten for a whole subtree on move. */
  path: MemoryPathSchema,
  /** Files only. */
  file: MemoryFileSchema.nullable(),
  createdAt: MillisSchema,
  createdBy: PrincipalIdSchema,
  updatedAt: MillisSchema,
  updatedBy: PrincipalIdSchema,
});
export type MemoryNode = z.infer<typeof MemoryNodeSchema>;
export type MemoryNodeWithId = MemoryNode & { id: string };

/** §E: a ticket's pointer at a memory file. */
export const MemoryRefSchema = z.object({
  memoryId: MemoryIdSchema,
  nodeId: MemoryNodeIdSchema,
});
export type MemoryRef = z.infer<typeof MemoryRefSchema>;
/** At most this many memory refs in one message / ticket write. */
export const MEMORY_REFS_MAX = 20;

// ─── paths inside a memory ───────────────────────────────────────────────────

/** 'a/b/c' → ['a','b','c']; '' → []; null when invalid. */
export function splitMemoryPath(p: string): string[] | null {
  if (p === '') return [];
  if (p.length > MEMORY_PATH_MAX) return null;
  const parts = p.split('/');
  if (parts.length > MEMORY_DEPTH_MAX) return null;
  for (const s of parts) if (!MemoryNodeNameSchema.safeParse(s).success) return null;
  return parts;
}

/**
 * What someone typed → a canonical path: backslashes to '/', leading and
 * trailing slashes and spaces trimmed per segment, runs of '/' collapsed.
 * Returns null when what is left is not a valid path.
 */
export function normalizeMemoryPath(input: string): string | null {
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const p = parts.join('/');
  return splitMemoryPath(p) === null ? null : p;
}

export const memoryParentPath = (p: string): string =>
  p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
export const memoryBaseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
export const joinMemoryPath = (parent: string, name: string): string =>
  parent === '' ? name : `${parent}/${name}`;
/** Is `p` equal to or inside `folder`? ('' contains everything.) */
export const memoryPathWithin = (p: string, folder: string): boolean =>
  folder === '' || p === folder || p.startsWith(folder + '/');

// ─── who may do what (§B, §D) ────────────────────────────────────────────────

/**
 * What a principal may do in one memory:
 *   'manage'  owner: share, grant, rename, delete the memory
 *   'write'   upload, edit, folders, move, delete nodes
 *   'read'    browse, preview, download, attach to a granted board's tickets
 *   null      nothing (and the memory answers 404)
 */
export type MemoryReach = 'manage' | 'write' | 'read' | null;

/**
 * THE ONE ANSWER (§D). `role` is the principal's own role on the memory (a
 * person; agents never have one). `boardRoles` are the principal's roles on
 * boards — only the GRANTED ones matter. A board 'read' grant gives every
 * member 'read'; a 'write' grant gives editors and admins 'write'. The best
 * of all routes wins. An archived memory is read-only to everyone but the
 * owner's manage (which may restore it); a deleting one reaches nobody.
 */
export function memoryReach(
  m: Pick<Memory, 'access' | 'boards' | 'archivedAt'> & { deletingAt?: number | null | undefined },
  who: {
    uid?: string | null | undefined;
    boardRoles?: ReadonlyMap<string, BoardRole | null | undefined> | undefined;
  },
): MemoryReach {
  if (m.deletingAt) return null;
  const rank = { read: 1, write: 2, manage: 3 } as const;
  let best: Exclude<MemoryReach, null> | null = null;
  const take = (r: Exclude<MemoryReach, null>) => {
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

export const memoryCan = {
  read: (r: MemoryReach): boolean => r !== null,
  write: (r: MemoryReach): boolean => r === 'write' || r === 'manage',
  manage: (r: MemoryReach): boolean => r === 'manage',
};

/**
 * §D for an artifact's page: the GRANT is the ceiling, the VIEWER's own reach
 * the floor. null = the page may not touch this memory.
 */
export function memoryArtifactReach(
  m: Pick<Memory, 'artifacts'>,
  artifactId: string,
  viewer: MemoryReach,
): 'read' | 'write' | null {
  const grant = m.artifacts?.[artifactId];
  if (!grant || !viewer) return null;
  return grant === 'write' && memoryCan.write(viewer) ? 'write' : 'read';
}

/** The emoji the sidebar shows. */
export const memoryGlyph = (m: Pick<Memory, 'icon'>): string => m.icon || '🧠';

// ─── previews ────────────────────────────────────────────────────────────────

export const MEMORY_PREVIEW_KINDS = [
  'markdown',
  'text',
  'image',
  'video',
  'audio',
  'pdf',
  'other',
] as const;
export type MemoryPreviewKind = (typeof MEMORY_PREVIEW_KINDS)[number];

const TEXT_EXT =
  /\.(txt|md|markdown|mdx|json|jsonc|ya?ml|toml|ini|env|csv|tsv|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|svelte|vue|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|gql|proto|dockerfile|gitignore|log|svg)$/i;

/** How the app previews a file, from its mime and name. */
export function memoryPreviewKind(name: string, mime: string): MemoryPreviewKind {
  const n = name.toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(n) || mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (isMemoryTextFile(name, mime)) return 'text';
  return 'other';
}

/** May Code mode show and edit this file as text? */
export function isMemoryTextFile(name: string, mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    /^application\/(json|xml|javascript|x-sh|x-yaml|yaml|toml|sql|graphql)/.test(mime) ||
    mime === 'image/svg+xml' ||
    TEXT_EXT.test(name) ||
    /^(dockerfile|makefile|readme|license)$/i.test(name)
  );
}
