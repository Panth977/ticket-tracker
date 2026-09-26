/**
 * installRemove (extra; Board settings › Integrations) — can(admin). The
 * integration is marked 'removed' (its config kept, so reconnecting restores
 * the linked repos) and its provider token is deleted from the secret store.
 */
import { errors, paths, type Integration } from '@tm/shared';
import { secretStore } from '../platform/integrations.js';
import { db } from '../runtime/firebase.js';
import { loadBoard, requireCan } from '../tickets/access.js';
import { defineCommand } from './_registry.js';

export default defineCommand('installRemove', async (ctx, input) => {
  const board = await loadBoard(ctx, input.boardId);
  requireCan(ctx, board, 'admin', null, null, 'Only board admins manage integrations');
  const ref = db().doc(paths.integration(board.id, input.provider));
  const snap = await ref.get();
  const it = snap.exists ? (snap.data() as Integration) : undefined;
  if (!it || it.status === 'removed') throw errors.not_found('Integration not found');
  await ref.update({ status: 'removed' });
  await secretStore.delete(board.id, input.provider);
  return { ok: true as const };
});
