/** orgDelete (§AC) — an empty org only: its things must be moved or deleted first. */
import { errors } from '@tm/shared';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { dropEnv } from '../env/shared.js';
import { handleRef, loadOrg, orgRef, requireOrgRole, thingsOf } from '../org/shared.js';

export default defineCommand('orgDelete', async (ctx, input) => {
  const org = await loadOrg(input.orgId);
  requireOrgRole(org, ctx, 'owner');
  if ((await thingsOf({ kind: 'org', id: input.orgId })).length)
    throw errors.conflict(
      'This org still owns boards, artifacts or buckets — move or delete them first',
    );
  await runTx(async (tx) => {
    tx.delete(orgRef(input.orgId));
    tx.delete(handleRef(org.handle));
  });
  await dropEnv('org', input.orgId);
  return { ok: true as const };
});
