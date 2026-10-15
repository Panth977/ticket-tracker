/**
 * boardAttachBucketSet (bucket.html §J) — where a file put on one of this
 * board's tickets goes by default: one of the buckets granted `write` to the
 * board, and a path template (tickets/<ticketId>/<time>_<filename>). null
 * clears it (the attach dialog then asks; server-side uploads are refused).
 *
 *   can(admin) on the board; never an agent; board not archived
 *   the bucket exists, is not being deleted, and boards[boardId] === 'write'
 *
 * Kept true afterwards: bucketGrantSet clears it when that write grant goes
 * (removed or lowered to read), bucketDelete when the bucket goes.
 */
import { errors, isAgentId } from '@tm/shared';
import { bucketRef } from '../bucket/shared.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { assertActive, boardRef, loadBoard } from './boardShared.js';

export default defineCommand('boardAttachBucketSet', async (ctx, { boardId, attachBucket }) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('An agent cannot change board settings');
  await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'admin');
    assertActive(board);
    if (attachBucket) {
      const bucket = await txGet(tx, bucketRef(attachBucket.bucketId));
      if (!bucket || bucket.deletingAt) throw errors.not_found('Bucket not found');
      if (bucket.boards?.[boardId] !== 'write')
        throw errors.invalid(
          'Attachments need a bucket this board may write — grant it write in board settings › Bucket',
          { field: 'attachBucket.bucketId' },
        );
    }
    tx.update(boardRef(boardId), { attachBucket, updatedAt: ctx.now });
  });
  return { ok: true as const };
});
