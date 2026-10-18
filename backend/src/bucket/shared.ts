/**
 * BUCKET (docs/plan/bucket.html) — what every bucket command, the file door,
 * REST/MCP and the delete job share. Not a command (lives outside commands/).
 *
 *   bucketRef / nodeRef / nodesCol   typed references
 *   boardRolesFor                     the caller's roles on the GRANTED boards
 *   reachFor / loadBucket             WHO IS THIS, HERE — bucketReach() decides
 *   toBucketOut / toNodeOut           the API shapes
 *
 * A bucket's people are its own (§B). Boards reach it only through a grant
 * stored on it (§D); agents only ever through a board (D-M4).
 *
 * TOKENS. The runner has already checked bucket:read / bucket:write. A board
 * token acting as a person (issued for one board) reaches no bucket, like an
 * artifact: it was not issued for one. Account tokens, OAuth grants and agent
 * tokens reach what bucketReach answers.
 *
 * NO REACH IS A 404, NOT A 403: a bucket is private, and "you may not" would
 * confirm that the id exists.
 */
import {
  can,
  COLLECTIONS,
  effectiveRole,
  errors,
  isAgentId,
  bucketCan,
  bucketReach,
  type Board,
  type BoardRole,
  type Bucket,
  type BucketNode,
  type BucketNodeOut,
  type BucketOut,
  type BucketReach,
  type BucketRole,
  type Uid,
  indicatorOf,
  BUCKET_DEFAULT_INDICATOR,
} from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { txGet, type Tx } from '../runtime/tx.js';
import { boardRef } from '../tickets/access.js';

const C = COLLECTIONS;

export const bucketPath = (bucketId: string) => `${C.buckets}/${bucketId}`;
export const nodesPath = (bucketId: string) => `${bucketPath(bucketId)}/${C.nodes}`;

export const bucketsCol = () => typedCol('buckets', C.buckets);
export const bucketRef = (bucketId: string) => typedDoc('buckets', bucketPath(bucketId));
export const nodesCol = (bucketId: string) => typedCol('bucketNodes', nodesPath(bucketId));
export const nodeRef = (bucketId: string, nodeId: string) =>
  typedDoc('bucketNodes', `${nodesPath(bucketId)}/${nodeId}`);
/** Untyped, for FieldValue.increment on the stats (the converter cannot check sentinels nested). */
export const rawBucketRef = (bucketId: string) => db().doc(bucketPath(bucketId));

export type BucketNeed = 'read' | 'write' | 'manage';

/** A board-scoped API key acting as its person (keyId set, narrowed to boards). */
export const isBoardTokenAsPerson = (
  ctx: Pick<ServerCtx, 'actor' | 'keyId' | 'boardIds'>,
): boolean =>
  !isAgentId(ctx.actor) && !!ctx.keyId && ctx.boardIds !== null && ctx.boardIds !== undefined;

/**
 * The caller's role on each GRANTED board (only those matter to bucketReach).
 * can(read) decides whether a role counts at all: it applies §AA1 (an agent
 * reaches a board only while its owner is on it) and a token's board narrowing.
 * Scopes are not asked here — the runner checked the bucket scopes already.
 */
export async function boardRolesFor(
  ctx: Pick<ServerCtx, 'actor' | 'ownerUid' | 'boardIds'>,
  bucket: Pick<Bucket, 'boards'>,
  tx?: Tx,
): Promise<Map<string, BoardRole>> {
  const ids = Object.keys(bucket.boards ?? {});
  const out = new Map<string, BoardRole>();
  if (!ids.length) return out;
  const docs = await Promise.all(
    ids.map((id) =>
      tx
        ? txGet(tx, boardRef(id))
        : boardRef(id)
            .get()
            .then((s) => s.data()),
    ),
  );
  const canCtx = { actor: ctx.actor, ownerUid: ctx.ownerUid, boardIds: ctx.boardIds };
  docs.forEach((b, i) => {
    if (!b || b.archivedAt != null) return;
    const board = { ...b, id: ids[i]! };
    if (!can(canCtx, board, 'read')) return;
    const role = effectiveRole(board, ctx.actor);
    if (role) out.set(board.id, role);
  });
  return out;
}

/** What the caller may do in this bucket (null = nothing; answer 404). */
export async function reachFor(
  ctx: ServerCtx,
  bucket: Bucket | undefined,
  tx?: Tx,
): Promise<BucketReach> {
  if (!bucket || bucket.deletingAt) return null;
  if (isBoardTokenAsPerson(ctx)) return null;
  const agent = isAgentId(ctx.actor);
  // An agent never holds a role on a bucket (D-M4): only boards count for it.
  const uid = agent ? null : ctx.actor;
  const needsBoards =
    agent ||
    !uid ||
    !Object.prototype.hasOwnProperty.call(bucket.access, uid) ||
    bucket.access[uid] !== 'owner';
  const boardRoles = needsBoards ? await boardRolesFor(ctx, bucket, tx) : new Map();
  return bucketReach(bucket, { uid, boardRoles });
}

const REFUSAL: Record<BucketNeed, string> = {
  read: 'You cannot open this bucket',
  write: 'You can read this bucket but not change it',
  manage: 'Only the owner of this bucket can do that',
};

export interface LoadedBucket {
  bucket: Bucket;
  reach: Exclude<BucketReach, null>;
}

/** Read a bucket (in `tx` when given) and gate it: 404 without reach, 403 with too little. */
export async function loadBucket(
  tx: Tx | null,
  bucketId: string,
  ctx: ServerCtx,
  need: BucketNeed,
): Promise<LoadedBucket> {
  const ref = bucketRef(bucketId);
  const bucket = tx ? await txGet(tx, ref) : (await ref.get()).data();
  const reach = await reachFor(ctx, bucket, tx ?? undefined);
  if (!bucket || !reach) {
    if (bucket && isBoardTokenAsPerson(ctx) && bucket.access[ctx.actor])
      throw errors.forbidden(
        'A board token cannot reach bucket — use an account token (Account › Tokens)',
      );
    throw errors.not_found('Bucket not found');
  }
  const ok =
    need === 'read'
      ? bucketCan.read(reach)
      : need === 'write'
        ? bucketCan.write(reach)
        : bucketCan.manage(reach);
  // Archived is read-only for everyone, the owner included, until restored.
  if (ok && need === 'write' && bucket.archivedAt !== null)
    throw errors.conflict('This bucket is archived — restore it first');
  if (!ok) {
    if (need === 'write' && bucket.archivedAt !== null)
      throw errors.conflict('This bucket is archived — restore it first');
    throw errors.forbidden(REFUSAL[need]);
  }
  return { bucket, reach };
}

/** `access` with its derived list. The ONLY way memberUids is ever computed. */
export function withMembers(access: Record<Uid, BucketRole>): {
  access: Record<Uid, BucketRole>;
  memberUids: Uid[];
} {
  return { access, memberUids: Object.keys(access).sort() };
}

export const toBucketOut = (
  id: string,
  m: Bucket,
  reach: Exclude<BucketReach, null>,
): BucketOut => ({
  id,
  name: m.name,
  description: m.description,
  icon: m.icon,
  indicator: indicatorOf(m, id, BUCKET_DEFAULT_INDICATOR),
  reach,
  archived: m.archivedAt !== null,
  stats: m.stats,
  updatedAt: m.updatedAt,
  storage:
    m.storage?.kind === 'drive'
      ? { kind: 'drive', folderName: m.storage.folderName, email: m.storage.email }
      : { kind: 'managed', folderName: null, email: null },
});

export function toNodeOut(id: string, n: BucketNode): BucketNodeOut {
  let file: BucketNodeOut['file'] = null;
  if (n.file) {
    const { storagePath: _s, ...rest } = n.file;
    file = rest;
  }
  return {
    id,
    kind: n.kind,
    parentId: n.parentId,
    name: n.name,
    path: n.path,
    file,
    updatedAt: n.updatedAt,
  };
}

/** Where a person opens a bucket in the app. */
export const bucketAppHref = (bucketId: string) => `/bucket/${bucketId}`;

/**
 * Every board the caller is on, with its role (bucketList: which granted
 * buckets it reaches). People by readerUids, agents by agentIds; the same
 * can(read) filter as boardRolesFor.
 */
export async function callerBoardRoles(
  ctx: Pick<ServerCtx, 'actor' | 'ownerUid' | 'boardIds'>,
): Promise<Map<string, BoardRole>> {
  const field = isAgentId(ctx.actor) ? 'agentIds' : 'readerUids';
  const snap = await db().collection(C.boards).where(field, 'array-contains', ctx.actor).get();
  const out = new Map<string, BoardRole>();
  const canCtx = { actor: ctx.actor, ownerUid: ctx.ownerUid, boardIds: ctx.boardIds };
  for (const d of snap.docs) {
    const b = { ...(d.data() as Board), id: d.id };
    if (b.archivedAt != null || !can(canCtx, b, 'read')) continue;
    const role = effectiveRole(b, ctx.actor);
    if (role) out.set(d.id, role);
  }
  return out;
}
