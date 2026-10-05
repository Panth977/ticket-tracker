/**
 * inviteRevoke — can(admin) on the invite's board, or its inviter.
 *
 *   resend  → a new token and a new expiry, and the e-mail again (the old
 *             link stops working: only the newest token's hash is stored).
 *             Counts toward the 50 invites / day.
 *   revoke  → status 'revoked': the link and the inbox row stop working.
 *
 * An ARTIFACT invite (invite.artifactId) follows the same two paths; the
 * authority is the artifact's owner instead of a board admin.
 */
import { errors, INVITE_TTL_MS, isAgentId, rateBuckets } from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { artifactRef, roleFor } from '../artifacts/shared.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { boardRef, INVITES_PER_DAY, sha256, takeRate } from './boardShared.js';
import { inviteInboxRef, inviteRef, isLive, sendInviteEmail, uidForEmail } from './inviteShared.js';

export default defineCommand('inviteRevoke', async (ctx, { inviteId, resend }) => {
  // §AA2 — an agent may be a board ADMIN now, so can(admin) alone no longer
  // says "a person". What an agent admin still cannot do is what no agent
  // can: manage invites (a board's or an artifact's). Refused here by who is acting, whatever the role.
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot manage invites');
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
      if (inv.artifactId) {
        // An artifact invite (artifacts.html §B): its OWNER, or whoever sent it.
        const artifact = await txGet(tx, artifactRef(inv.artifactId));
        const role = artifact ? roleFor(ctx, artifact) : null;
        if (role !== 'owner' && inv.invitedBy !== ctx.actor)
          throw role
            ? errors.forbidden('Only the owner or the inviter can change this invite')
            : errors.not_found('Invite not found');
        if (!artifact || artifact.deletingAt) throw errors.gone('This artifact no longer exists');
      } else {
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
      }
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
