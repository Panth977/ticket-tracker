/**
 * ownerTransfer (§AC) — move a board, artifact, bucket or dictionary to another owner,
 * like transferring a GitHub repo: to a person (yourself or anyone else, who
 * becomes its admin / owner) or to an org where you are an owner or admin.
 * Its people stay; the old org's grants are taken back and the new org's
 * added (syncThing). An artifact or bucket gets a slug that is free at its
 * new owner.
 */
import { errors, isAgentId, ownerKeyOf, paths, roleOf, type OwnerRef } from '@tm/shared';
import { artifactRef } from '../artifacts/shared.js';
import { bucketRef, reachFor } from '../bucket/shared.js';
import { dictionaryRef } from '../dictionary/shared.js';
import { boardRef } from './boardShared.js';
import { defineCommand } from './_registry.js';
import { db } from '../db/index.js';
import {
  freeSlug,
  grantOwner,
  handleOf,
  loadOrg,
  requireOrgRole,
  syncThing,
} from '../org/shared.js';

export default defineCommand('ownerTransfer', async (ctx, input) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot move things between owners');
  const { kind, id } = input.thing;
  const to: OwnerRef = input.to;

  // May I fully manage it?
  let name: string;
  let from: OwnerRef | undefined;
  if (kind === 'board') {
    const b = (await boardRef(id).get()).data();
    if (!b) throw errors.not_found('No such board');
    if (roleOf(b, ctx.actor) !== 'admin')
      throw errors.forbidden('Only the board’s admins can move it');
    name = b.name;
    from = b.owner;
  } else if (kind === 'artifact') {
    const a = (await artifactRef(id).get()).data();
    if (!a || a.deletingAt) throw errors.not_found('No such artifact');
    if (a.access[ctx.actor] !== 'owner') throw errors.forbidden('Only its owners can move it');
    name = a.name;
    from = a.owner;
  } else if (kind === 'dictionary') {
    const d = (await dictionaryRef(id).get()).data();
    if (!d) throw errors.not_found('No such dictionary');
    if (d.access[ctx.actor] !== 'owner') throw errors.forbidden('Only its owners can move it');
    name = d.name;
    from = d.owner;
  } else {
    const m = (await bucketRef(id).get()).data();
    if (!m) throw errors.not_found('No such bucket');
    if ((await reachFor(ctx, m)) !== 'manage')
      throw errors.forbidden('Only its owners can move it');
    name = m.name;
    from = m.owner;
  }

  // May I own things there?
  let org = null;
  if (to.kind === 'user') {
    if (isAgentId(to.id)) throw errors.invalid('Things belong to people or orgs, not agents');
    const u = (await db().doc(paths.user(to.id)).get()).data() as
      { deletedAt?: number } | undefined;
    if (!u || u.deletedAt) throw errors.not_found('No such person');
  } else {
    org = await loadOrg(to.id);
    requireOrgRole(org, ctx, 'admin');
  }
  if (from && ownerKeyOf(from) === ownerKeyOf(to))
    return { ok: true as const, owner: to, handle: await handleOf(to) };

  const fields: Record<string, unknown> = {
    owner: to,
    ownerKey: ownerKeyOf(to),
    ownerHandle: await handleOf(to),
  };
  if (kind !== 'board') fields.slug = await freeSlug(kind, to, name, id);
  const ref =
    kind === 'board'
      ? boardRef(id)
      : kind === 'artifact'
        ? artifactRef(id)
        : kind === 'dictionary'
          ? dictionaryRef(id)
          : bucketRef(id);
  await (ref as ReturnType<typeof boardRef>).update(fields as never);
  // The old org's grants go (null org), then the new one's come.
  await syncThing(kind, id, null);
  if (org) await syncThing(kind, id, org);
  else await grantOwner(kind, id, to.id);
  return { ok: true as const, owner: to, handle: await handleOf(to) };
});
