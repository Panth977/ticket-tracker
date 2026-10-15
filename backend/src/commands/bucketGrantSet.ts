/**
 * bucketGrantSet (bucket.html §D) — let a board or an artifact use this
 * bucket ('read' | 'write'), or stop it (null).
 *
 * BOTH SIDES must agree to GRANT, so the caller must own the bucket AND be an
 * admin of the board (or the owner of the artifact). EITHER SIDE may END it
 * (access null): the bucket's owner takes their bucket back, a board admin
 * drops it from the board (board settings › Subscriptions), the artifact's
 * owner drops it from the artifact. A caller who is neither learns nothing
 * about the bucket (404). Never an agent.
 *
 * bucket.html §J: a board whose attachment bucket this is (board.attachBucket)
 * loses that default, in the same transaction, when the board's `write` goes
 * (removed, or lowered to read).
 */
import { errors, isAgentId, BUCKET_GRANTS_MAX, type Bucket } from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { loadArtifact } from '../artifacts/shared.js';
import { loadBucket, bucketRef } from '../bucket/shared.js';
import { runTx, txGet, type Tx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { boardRef, loadBoard } from './boardShared.js';

export default defineCommand(
  'bucketGrantSet',
  async (ctx, { bucketId, boardId, artifactId, access }) => {
    if (isAgentId(ctx.actor)) throw errors.forbidden('An agent cannot grant a bucket');
    await runTx(async (tx) => {
      const bucket =
        access === null
          ? await loadForRevoke(tx, bucketId, ctx, { boardId, artifactId })
          : (await loadBucket(tx, bucketId, ctx, 'manage')).bucket;
      if (!bucket) return;
      const patch: Partial<Bucket> = { updatedAt: ctx.now };
      let unsetDefault = false;
      if (boardId) {
        const boards = { ...bucket.boards };
        // §J: the board's default attachment bucket stops being one without write.
        if (access !== 'write' && boards[boardId] === 'write') {
          const b = await txGet(tx, boardRef(boardId));
          unsetDefault = b?.attachBucket?.bucketId === bucketId;
        }
        if (access === null) {
          if (!Object.prototype.hasOwnProperty.call(boards, boardId)) return;
          delete boards[boardId];
        } else {
          // 'admin' — board settings are where a board's buckets are chosen.
          await loadBoard(tx, boardId, { ...ctx, scopes: undefined }, 'admin');
          if (!(boardId in boards) && Object.keys(boards).length >= BUCKET_GRANTS_MAX)
            throw errors.conflict(`A bucket can be used by at most ${BUCKET_GRANTS_MAX} boards`);
          if (boards[boardId] === access) return;
          boards[boardId] = access;
        }
        patch.boards = boards;
        patch.boardIds = Object.keys(boards).sort();
      } else if (artifactId) {
        const artifacts = { ...bucket.artifacts };
        if (access === null) {
          if (!Object.prototype.hasOwnProperty.call(artifacts, artifactId)) return;
          delete artifacts[artifactId];
        } else {
          await loadArtifact(tx, artifactId, { ...ctx, scopes: undefined }, 'manage');
          if (!(artifactId in artifacts) && Object.keys(artifacts).length >= BUCKET_GRANTS_MAX)
            throw errors.conflict(`A bucket can be used by at most ${BUCKET_GRANTS_MAX} artifacts`);
          if (artifacts[artifactId] === access) return;
          artifacts[artifactId] = access;
        }
        patch.artifacts = artifacts;
      }
      tx.update(bucketRef(bucketId), patch);
      if (boardId && unsetDefault)
        tx.update(boardRef(boardId), { attachBucket: null, updatedAt: ctx.now });
    });
    return { ok: true as const };
  },
);

/**
 * Who may END a grant: the bucket's owner, or — for THAT grant only — an admin
 * of the board / the owner of the artifact. Answers the bucket, or null when
 * there is nothing to remove (the side asking already lost it). Anyone else:
 * 404 when the bucket is out of their reach, 403 when it is in it.
 */
async function loadForRevoke(
  tx: Tx,
  bucketId: string,
  ctx: ServerCtx,
  target: { boardId?: string | undefined; artifactId?: string | undefined },
): Promise<Bucket | null> {
  const bucket = await txGet(tx, bucketRef(bucketId));
  if (!bucket || bucket.deletingAt) throw errors.not_found('Bucket not found');
  const own = Object.prototype.hasOwnProperty.call(bucket.access, ctx.actor);
  if (own && bucket.access[ctx.actor] === 'owner') return bucket;
  const plain = { ...ctx, scopes: undefined };
  const granted = target.boardId
    ? Object.prototype.hasOwnProperty.call(bucket.boards ?? {}, target.boardId)
    : Object.prototype.hasOwnProperty.call(bucket.artifacts ?? {}, target.artifactId ?? '');
  if (target.boardId) {
    // Not on the board → 404; on it but not admin → 403 (its members reach the bucket anyway).
    await loadBoard(tx, target.boardId, plain, 'admin');
  } else if (target.artifactId) {
    await loadArtifact(tx, target.artifactId, plain, 'manage');
  }
  // The other side never had it: say nothing about the bucket.
  if (!granted) {
    if (own) return null;
    throw errors.not_found('Bucket not found');
  }
  return bucket;
}
