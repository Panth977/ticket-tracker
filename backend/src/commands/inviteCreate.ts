/**
 * inviteCreate — can(admin), or an editor when board.settings.editorsCanInvite
 * (editors may not hand out admin). 50 invites per person per day.
 *
 * For each e-mail (lower-cased, de-duplicated):
 *   an account with it already on the board  → alreadyOnBoard
 *   a pending invite exists                   → refreshed (new token, expiry,
 *                                                role, message), not duplicated
 *   otherwise                                 → invites/{id} with sha256(token)
 * then the e-mail, and — when an account with that address exists — an
 * 'invited' inbox row with Accept / Decline right in it.
 *
 * A PERSON ONLY (§AA2): an agent token carries board:admin, which is one of
 * this command's scopes, and its agent may be a board admin — so the handler
 * refuses an agent actor itself. Inviting stays with people and their tokens.
 *
 * ANYONE CAN BE INVITED — they need not have an account yet; they sign up
 * with that address and the invite is waiting in their inbox.
 */
import { errors, INVITE_TTL_MS, isAgentId, paths, rateBuckets, type Invite } from '@tm/shared';
import { roleOf } from '@tm/shared/logic/index';
import { typedCol } from '../runtime/converters.js';
import { runTx, txGetAll } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import {
  assertActive,
  INVITES_PER_DAY,
  loadBoard,
  loadBoardNoTx,
  profileOf,
  sha256,
  takeRate,
} from './boardShared.js';
import {
  inviteInboxItem,
  inviteInboxRef,
  inviteRef,
  isLive,
  sendInviteEmail,
  uidForEmail,
} from './inviteShared.js';

function assertMayInvite(
  board: Parameters<typeof roleOf>[0] & { settings: { editorsCanInvite?: boolean } },
  actor: string,
  roles: Invite['role'][],
): void {
  const role = roleOf(board, actor);
  if (role === 'admin') return;
  if (role === 'editor' && board.settings.editorsCanInvite) {
    if (roles.includes('admin')) throw errors.forbidden('Only admins can invite admins');
    return;
  }
  throw errors.forbidden('Only admins can invite people to this board');
}

export default defineCommand('inviteCreate', async (ctx, input) => {
  const { boardId } = input;
  // §AA2 — an agent may be a board ADMIN now, so can(admin) alone no longer
  // says "a person". What an agent admin still cannot do is what no agent
  // can: invite people to a board. Refused here by who is acting, whatever the role.
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot invite people');
  // Last role wins for an address listed twice.
  const wanted = new Map<string, Invite['role']>();
  for (const i of input.invites) wanted.set(i.email, i.role);

  const pre = await loadBoardNoTx(boardId, ctx, 'read');
  assertMayInvite(pre, ctx.actor, [...wanted.values()]);
  assertActive(pre);

  // Who already has an account, and who of those is already here.
  const uids = new Map<string, string | null>();
  for (const email of wanted.keys()) uids.set(email, await uidForEmail(email));
  const alreadyOnBoard = [...wanted.keys()].filter((e) => {
    const uid = uids.get(e);
    return !!uid && uid in pre.access;
  });
  const targets = [...wanted.keys()].filter((e) => !alreadyOnBoard.includes(e));
  if (targets.length === 0) return { invited: [], alreadyOnBoard };

  const pendingSnap = await typedCol('invites', paths.invites())
    .where('boardId', '==', boardId)
    .where('status', '==', 'pending')
    .get();
  const pendingByEmail = new Map(pendingSnap.docs.map((d) => [d.data().email, d.id]));

  const inviter = await profileOf(ctx.actor);
  const refund = await takeRate(
    rateBuckets.invites(ctx.actor),
    INVITES_PER_DAY,
    ctx.now,
    targets.length,
  );

  const plan = targets.map((email) => ({
    email,
    existingId: pendingByEmail.get(email),
    newId: ctx.ids.id(),
    token: ctx.ids.token(32),
  }));

  let sent: { id: string; inv: Invite; token: string }[];
  try {
    sent = await runTx(async (tx) => {
      const board = await loadBoard(tx, boardId, ctx, 'read');
      assertMayInvite(board, ctx.actor, [...wanted.values()]);
      assertActive(board);
      const existing = await txGetAll(
        tx,
        plan.map((p) => inviteRef(p.existingId ?? p.newId)),
      );
      const out: { id: string; inv: Invite; token: string }[] = [];
      plan.forEach((p, i) => {
        const prev = p.existingId ? existing[i] : undefined;
        const refresh = prev && isLive(prev, ctx.now);
        const id = refresh ? p.existingId! : p.newId;
        if (prev && !refresh) tx.update(inviteRef(p.existingId!), { status: 'expired' });
        const inv: Invite = {
          boardId,
          boardName: board.name,
          boardKey: board.key,
          email: p.email,
          role: wanted.get(p.email)!,
          invitedBy: ctx.actor,
          invitedByName: inviter.name,
          message: input.message ?? null,
          tokenHash: sha256(p.token),
          status: 'pending',
          expiresAt: ctx.now + INVITE_TTL_MS,
          createdAt: refresh ? prev.createdAt : ctx.now,
        };
        tx.set(inviteRef(id), inv);
        const uid = uids.get(p.email);
        if (uid) tx.set(inviteInboxRef(uid, id), inviteInboxItem(inv, id, ctx.via, ctx.now));
        out.push({ id, inv, token: p.token });
      });
      return out;
    });
  } catch (e) {
    await refund();
    throw e;
  }

  for (const s of sent) await sendInviteEmail(s.inv, s.id, s.token, ctx.email ?? inviter.email);
  return { invited: targets, alreadyOnBoard };
});
