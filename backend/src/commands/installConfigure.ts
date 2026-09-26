/**
 * installConfigure (extra; Board settings › Integrations) — can(admin). What a
 * connected provider does for THIS board: GitHub repos linked to it (and the
 * stage a merged PR moves its tickets to), the Slack channel it posts to, and
 * which events. Only the keys sent are replaced; the rest of config stays.
 * (Added by integration: the GitHub repo picker had no command.)
 */
import { errors, paths, type Integration } from '@tm/shared';
import { db } from '../runtime/firebase.js';
import { loadBoard, requireCan } from '../tickets/access.js';
import { defineCommand } from './_registry.js';

export default defineCommand('installConfigure', async (ctx, input) => {
  const board = await loadBoard(ctx, input.boardId);
  requireCan(ctx, board, 'admin', null, null, 'Only board admins manage integrations');
  const ref = db().doc(paths.integration(board.id, input.provider));
  const snap = await ref.get();
  const it = snap.exists ? (snap.data() as Integration) : undefined;
  if (!it || it.status === 'removed')
    throw errors.not_found('Integration not found — connect it first');

  if (input.repos && input.provider !== 'github')
    throw errors.invalid('Repos are a GitHub setting', { field: 'repos' });
  if (input.channelId && input.provider !== 'slack')
    throw errors.invalid('A channel is a Slack setting', { field: 'channelId' });
  const stageIds = new Set(board.stages.map((s) => s.id));
  const badStage = input.repos?.find((r) => r.moveOnMerge && !stageIds.has(r.moveOnMerge));
  if (badStage)
    throw errors.invalid(`No stage ${badStage.moveOnMerge} on this board`, { field: 'repos' });

  const config: Integration['config'] = { ...it.config };
  if (input.repos) config.repos = input.repos;
  if (input.channelId) config.channelId = input.channelId;
  if (input.events) config.events = input.events;
  await ref.update({ config });
  return { ok: true as const };
});
