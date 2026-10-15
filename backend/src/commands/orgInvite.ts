/**
 * orgInvite (§AC) — invite people into an org, as owner / admin / member.
 * The same invites/ documents, e-mail and inbox row as a board invite (the
 * board fields hold ORG_INVITE_BOARD_ID / _KEY and the org's name), so
 * accepting, declining, resending and revoking work as they do for boards.
 */
import {
  errors,
  INVITE_TTL_MS,
  ORG_INVITE_BOARD_ID,
  ORG_INVITE_BOARD_KEY,
  paths,
  rateBuckets,
  type Invite,
} from '@tm/shared';
import { typedCol } from '../runtime/converters.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { INVITES_PER_DAY, profileOf, sha256, takeRate } from './boardShared.js';
import {
  inviteInboxItem,
  inviteInboxRef,
  inviteRef,
  sendInviteEmail,
  uidForEmail,
} from './inviteShared.js';
import { loadOrg, requireOrgRole } from '../org/shared.js';

export default defineCommand('orgInvite', async (ctx, input) => {
  const org = await loadOrg(input.orgId);
  const mine = requireOrgRole(org, ctx, 'admin');
  const wanted = new Map<string, 'owner' | 'admin' | 'member'>();
  for (const i of input.invites) wanted.set(i.email.toLowerCase(), i.role);
  if (mine !== 'owner' && [...wanted.values()].includes('owner'))
    throw errors.forbidden('Only owners can invite owners');

  const uids = new Map<string, string | null>();
  for (const e of wanted.keys()) uids.set(e, await uidForEmail(e));
  const alreadyMembers = [...wanted.keys()].filter((e) => {
    const uid = uids.get(e);
    return !!uid && uid in org.members;
  });
  const targets = [...wanted.keys()].filter((e) => !alreadyMembers.includes(e));
  if (!targets.length) return { invited: [], alreadyMembers };

  const pending = await typedCol('invites', paths.invites())
    .where('orgId', '==', input.orgId)
    .where('status', '==', 'pending')
    .get();
  const pendingByEmail = new Map(pending.docs.map((d) => [d.data().email, d.id]));
  const inviter = await profileOf(ctx.actor);
  const refund = await takeRate(
    rateBuckets.invites(ctx.actor),
    INVITES_PER_DAY,
    ctx.now,
    targets.length,
  );
  let sent: { id: string; inv: Invite; token: string }[];
  try {
    sent = await runTx(async (tx) => {
      const out: { id: string; inv: Invite; token: string }[] = [];
      for (const email of targets) {
        const id = pendingByEmail.get(email) ?? ctx.ids.id();
        const token = ctx.ids.token(32);
        const inv: Invite = {
          boardId: ORG_INVITE_BOARD_ID,
          boardKey: ORG_INVITE_BOARD_KEY,
          boardName: org.name,
          email,
          role: 'viewer',
          orgId: input.orgId,
          orgRole: wanted.get(email)!,
          invitedBy: ctx.actor,
          invitedByName: inviter.name,
          message: input.message ?? null,
          tokenHash: sha256(token),
          status: 'pending',
          expiresAt: ctx.now + INVITE_TTL_MS,
          createdAt: ctx.now,
        };
        tx.set(inviteRef(id), inv);
        const uid = uids.get(email);
        if (uid) tx.set(inviteInboxRef(uid, id), inviteInboxItem(inv, id, ctx.via, ctx.now));
        out.push({ id, inv, token });
      }
      return out;
    });
  } catch (e) {
    await refund();
    throw e;
  }
  for (const s of sent) await sendInviteEmail(s.inv, s.id, s.token, ctx.email ?? inviter.email);
  return { invited: targets, alreadyMembers };
});
