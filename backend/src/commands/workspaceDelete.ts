/** workspaceDelete (agents.html §AB) — the grouping goes; its boards and artifacts are untouched. */
import { errors, paths } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { personOnly } from './workspaceShared.js';

export default defineCommand('workspaceDelete', async (ctx, { workspaceId }) => {
  personOnly(ctx);
  await runTx(async (tx) => {
    const ref = typedDoc('workspaces', paths.workspace(ctx.actor, workspaceId));
    if (!(await txGet(tx, ref))) throw errors.not_found('Workspace not found');
    tx.delete(ref);
  });
  return { ok: true as const };
});
