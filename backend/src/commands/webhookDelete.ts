/**
 * webhookDelete (extra; DELETE /v1/webhooks/{id}) — can(admin). The
 * deliveries log goes with it (its rows would otherwise outlive the TTL
 * reaper's reason to exist).
 */
import { errors, paths } from '@tm/shared';
import { db } from '../runtime/firebase.js';
import { loadBoard, requireCan } from '../tickets/access.js';
import { defineCommand } from './_registry.js';

export default defineCommand('webhookDelete', async (ctx, input) => {
  const board = await loadBoard(ctx, input.boardId);
  requireCan(ctx, board, 'admin', null, null, 'Only board admins manage webhooks');
  const ref = db().doc(paths.webhook(board.id, input.webhookId));
  if (!(await ref.get()).exists) throw errors.not_found('Webhook not found');
  await db().recursiveDelete(ref);
  return { ok: true as const };
});
