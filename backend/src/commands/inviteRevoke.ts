/**
 * inviteRevoke — can(admin) on the invite's board, or its inviter.
 *
 *   resend  → a new token and a new expiry, and the e-mail again (the old
 *             link stops working: only the newest token's hash is stored).
 *             Counts toward the 50 invites / day.
 *   revoke  → status 'revoked': the link and the inbox row stop working.
 */
import { errors, INVITE_TTL_MS, rateBuckets } from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { boardRef, INVITES_PER_DAY, sha256, takeRate } from './boardShared.js';
import { inviteInboxRef, inviteRef, isLive, sendInviteEmail, uidForEmail } from './inviteShared.js';

export default defineCommand('inviteRevoke', async (ctx, { inviteId, resend }) => {
  const first = (await inviteRef(inviteId).get()).data();
  if (!first) throw errors.not_found('Invite not found');
  const inviteeUid = await uidForEmail(first.email);
  const token = ctx.ids.token(32);
  const refund = resend
    ? await takeRate(rateBuckets.invites(ctx.actor), INVITES_PER_DAY, ctx.now)
    : async () => {};

  let result;
  try {
    result = await runTx(async (tx) => {
      const inv = await txGet(tx, inviteRef(inviteId));
      if (!inv) throw errors.not_found('Invite not found');
      const board = await txGet(tx, boardRef(inv.boardId));
      const isAdmin = !!board && can(ctx, { ...board, id: inv.boardId }, 'admin');
      if (!isAdmin && inv.invitedBy !== ctx.actor) {
        // Never confirm an invite exists to someone with no business on the board.
        const onBoard = !!board && can(ctx, { ...board, id: inv.boardId }, 'read');
        throw onBoard
          ? errors.forbidden('Only admins or the inviter can change this invite')
          : errors.not_found('Invite not found');
      }
      if (!board) throw errors.gone('This board no longer exists');
      if (!isLive(inv, ctx.now) && !(resend && inv.status === 'pending'))
        throw errors.gone(`This invite is ${inv.status === 'pending' ? 'expired' : inv.status}`);

      const row = inviteeUid ? await txGet(tx, inviteInboxRef(inviteeUid, inviteId)) : undefined;
      if (resend) {
        const next = { tokenHash: sha256(token), expiresAt: ctx.now + INVITE_TTL_MS };
        tx.update(inviteRef(inviteId), next);
        if (row)
          tx.update(inviteInboxRef(inviteeUid!, inviteId), {
            readAt: null,
            archivedAt: null,
            createdAt: ctx.now,
          });
        return { ...inv, ...next };
      }
      tx.update(inviteRef(inviteId), { status: 'revoked' });
      if (row) tx.update(inviteInboxRef(inviteeUid!, inviteId), { archivedAt: ctx.now });
      return null;
    });
  } catch (e) {
    await refund();
    throw e;
  }

  if (result) await sendInviteEmail(result, inviteId, token, ctx.email);
  return { ok: true as const };
});
