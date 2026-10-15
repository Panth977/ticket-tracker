/**
 * orgMemberSet (§AC) — change a member's role or remove them (null), then
 * re-apply the org to everything it owns: what it gave them changes with it.
 */
import { errors, type OrgRole } from '@tm/shared';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { loadOrg, orgMembers, orgRef, orgRoleOf, requireOrgRole, syncOrg } from '../org/shared.js';

export default defineCommand('orgMemberSet', async (ctx, input) => {
  const { orgId, uid, role } = input;
  await runTx(async (tx) => {
    const org = await loadOrg(orgId, tx);
    const self = uid === ctx.actor;
    const cur = orgRoleOf(org, uid);
    if (!cur) throw errors.not_found('Not a member of this org');
    if (!(self && role === null)) {
      const mine = requireOrgRole(org, ctx, 'admin');
      if ((cur === 'owner' || role === 'owner') && mine !== 'owner')
        throw errors.forbidden('Only owners can change owners');
    } else if (!orgRoleOf(org, ctx.actor)) throw errors.not_found('No such org');
    const members: Record<string, OrgRole> = { ...org.members };
    if (role === null) delete members[uid];
    else members[uid] = role;
    if (!Object.values(members).includes('owner'))
      throw errors.conflict('An org always keeps an owner — make someone else owner first');
    tx.update(orgRef(orgId), { ...orgMembers(members), updatedAt: ctx.now });
  });
  await syncOrg(orgId);
  return { ok: true as const };
});
