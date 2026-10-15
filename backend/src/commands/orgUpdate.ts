/** orgUpdate (§AC) — name, handle, description, mark, base role (re-applied to everything it owns). */
import { descriptionText } from '@tm/shared/logic/index';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import {
  claimHandle,
  handleRef,
  loadOrg,
  orgRef,
  requireOrgRole,
  restampHandle,
  syncOrg,
} from '../org/shared.js';

export default defineCommand('orgUpdate', async (ctx, input) => {
  const { orgId } = input;
  let resync = false;
  await runTx(async (tx) => {
    const org = await loadOrg(orgId, tx);
    requireOrgRole(org, ctx, 'admin');
    const patch: Record<string, unknown> = { updatedAt: ctx.now };
    if (input.handle && input.handle !== org.handle) {
      await claimHandle(tx, input.handle, { kind: 'org', id: orgId });
      tx.delete(handleRef(org.handle));
      patch.handle = input.handle;
    }
    if (input.name !== undefined) patch.name = input.name;
    if (input.indicator !== undefined) patch.indicator = input.indicator;
    if (input.description !== undefined)
      patch.description = descriptionText(input.description) ?? null;
    if (input.baseRole !== undefined && input.baseRole !== org.baseRole) {
      patch.baseRole = input.baseRole;
      resync = true;
    }
    tx.update(orgRef(orgId), patch);
  });
  if (resync) await syncOrg(orgId);
  if (input.handle) await restampHandle({ kind: 'org', id: orgId }, input.handle);
  return { ok: true as const };
});
