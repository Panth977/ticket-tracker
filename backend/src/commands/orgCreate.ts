/** orgCreate (§AC) — a new org; its creator is its owner, its handle claimed in the same transaction. */
import { errors, isAgentId, ORGS_PER_PERSON_MAX, paths, type Org } from '@tm/shared';
import { descriptionText } from '@tm/shared/logic/index';
import { db } from '../db/index.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { claimHandle, orgMembers, orgRef } from '../org/shared.js';

export default defineCommand('orgCreate', async (ctx, input) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Orgs are made by people, not agents');
  const mine = await db()
    .collection(paths.orgs())
    .where('memberUids', 'array-contains', ctx.actor)
    .get();
  if (
    mine.docs.filter((d) => (d.data() as Org).members[ctx.actor] === 'owner').length >=
    ORGS_PER_PERSON_MAX
  )
    throw errors.conflict(`You can own at most ${ORGS_PER_PERSON_MAX} orgs`);
  const orgId = ctx.ids.id();
  const description = descriptionText(input.description);
  await runTx(async (tx) => {
    await claimHandle(tx, input.handle, { kind: 'org', id: orgId });
    const org: Org = {
      handle: input.handle,
      name: input.name,
      ...(description ? { description } : {}),
      ...(input.indicator ? { indicator: input.indicator } : {}),
      ...orgMembers({ [ctx.actor]: 'owner' }),
      baseRole: input.baseRole ?? 'editor',
      createdBy: ctx.actor,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    tx.create(orgRef(orgId), org);
  });
  return { orgId, handle: input.handle };
});
