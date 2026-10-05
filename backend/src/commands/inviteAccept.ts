/**
 * inviteAccept — accept (or decline) an invite, from the e-mail link (token)
 * or from the inbox row (no token).
 *
 *   invite pending && not expired            → 410 otherwise
 *   token given: sha256(token) == tokenHash  → 404 otherwise
 *   VERIFIED sign-in e-mail == invite.email  → 403 otherwise
 *
 * THE ACCEPTING ACCOUNT MUST OWN THE INVITED ADDRESS: a forwarded link is the
 * most common way access goes to the wrong person.
 *
 * accept, in one transaction: access[uid] = role (never a downgrade if they
 * are already on the board), readerUids / editorUids, members/{uid} from
 * users/{uid}, invite 'accepted', the inbox row done. Then the RTDB mirror
 * and the inviter is told. decline: status 'declined'; the inviter is told.
 *
 * AN ARTIFACT INVITE (docs/plan/artifacts.html §B — invite.artifactId set) is
 * the same three checks and the same two outcomes; what is granted is
 * artifacts/{id}.access[uid] instead of a board role. It is kept in this
 * command on purpose: one link format, one inbox row, one place that decides
 * whether the account owns the invited address.
 */
import {
  ARTIFACT_INVITE_BOARD_ID,
  ARTIFACT_INVITE_BOARD_KEY,
  errors,
  paths,
  type ArtifactRole,
  type BoardRole,
} from '@tm/shared';
import {
  artifactInboxRow,
  artifactRef,
  syncArtifactMirror,
  withMembers,
} from '../artifacts/shared.js';
import { typedDoc } from '../runtime/converters.js';
import { notify } from '../notify/index.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import {
  boardRef,
  deriveAccess,
  memberDoc,
  memberRef,
  profileOf,
  sha256,
  syncReaders,
} from './boardShared.js';
import { inviteInboxRef, inviteRef, isLive, maskEmail } from './inviteShared.js';

const RANK: Record<BoardRole, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3 };
/** Accepting never downgrades: an owner who is sent a viewer invite stays the owner. */
const ARTIFACT_RANK: Record<ArtifactRole, number> = { viewer: 0, editor: 1, owner: 2 };

export default defineCommand('inviteAccept', async (ctx, { inviteId, token, accept }) => {
  const profile = await profileOf(ctx.actor);

  const res = await runTx(async (tx) => {
    const inv = await txGet(tx, inviteRef(inviteId));
    if (!inv) throw errors.not_found('Invite not found');
    if (!isLive(inv, ctx.now))
      throw errors.gone(
        inv.status === 'pending' || inv.status === 'expired'
          ? 'This invite has expired — ask for a new one'
          : `This invite was already ${inv.status}`,
        { status: inv.expiresAt <= ctx.now && inv.status === 'pending' ? 'expired' : inv.status },
      );
    if (token !== undefined && sha256(token) !== inv.tokenHash)
      throw errors.not_found('Invite not found');
    const email = (ctx.email ?? '').toLowerCase();
    if (!ctx.emailVerified || email !== inv.email)
      throw errors.forbidden(`This invite is for ${maskEmail(inv.email)} — switch account`, {
        invitedEmail: maskEmail(inv.email),
      });

    // ── an artifact invite ──
    if (inv.artifactId) {
      const artifactId = inv.artifactId;
      const artifact = await txGet(tx, artifactRef(artifactId));
      if (!artifact || artifact.deletingAt) throw errors.gone('This artifact no longer exists');
      const inbox = inviteInboxRef(ctx.actor, inviteId);
      const row = await txGet(tx, inbox);
      if (row) tx.update(inbox, { readAt: ctx.now, archivedAt: ctx.now });
      if (!accept) {
        tx.update(inviteRef(inviteId), { status: 'declined' });
        return { kind: 'artifact' as const, inv, artifactId, artifact, joined: false };
      }
      const wanted = inv.role === 'editor' ? 'editor' : 'viewer';
      const current = Object.prototype.hasOwnProperty.call(artifact.access, ctx.actor)
        ? artifact.access[ctx.actor]
        : undefined;
      const role = current && ARTIFACT_RANK[current] >= ARTIFACT_RANK[wanted] ? current : wanted;
      const next = { ...artifact, ...withMembers({ ...artifact.access, [ctx.actor]: role }) };
      tx.update(artifactRef(artifactId), {
        access: next.access,
        memberUids: next.memberUids,
        updatedAt: ctx.now,
      });
      tx.update(inviteRef(inviteId), { status: 'accepted' });
      return { kind: 'artifact' as const, inv, artifactId, artifact: next, joined: true };
    }

    // ── a board invite ──
    const board = await txGet(tx, boardRef(inv.boardId));
    if (!board) throw errors.gone('This board no longer exists');
    const inbox = inviteInboxRef(ctx.actor, inviteId);
    const row = await txGet(tx, inbox);
    const member = await txGet(tx, memberRef(inv.boardId, ctx.actor));

    if (row) tx.update(inbox, { readAt: ctx.now, archivedAt: ctx.now });
    if (!accept) {
      tx.update(inviteRef(inviteId), { status: 'declined' });
      return { kind: 'board' as const, inv, board, joined: false, readerUids: null };
    }

    const current = board.access[ctx.actor];
    const role = current && RANK[current] >= RANK[inv.role] ? current : inv.role;
    const access = { ...board.access, [ctx.actor]: role };
    const derived = deriveAccess(access);
    tx.update(boardRef(inv.boardId), { access, ...derived });
    if (member) tx.update(memberRef(inv.boardId, ctx.actor), { role });
    else
      tx.set(
        memberRef(inv.boardId, ctx.actor),
        memberDoc(ctx.actor, role, profile, inv.invitedBy, ctx.now),
      );
    tx.update(inviteRef(inviteId), { status: 'accepted' });
    return { kind: 'board' as const, inv, board, joined: true, readerUids: derived.readerUids };
  });

  if (res.kind === 'artifact') {
    if (res.joined) await syncArtifactMirror(res.artifactId, res.artifact);
    // The person who shared it is told, in their inbox (artifacts have no notify router).
    await typedDoc(
      'inbox',
      paths.inboxItem(res.inv.invitedBy, `artifact_${res.artifactId}_joined_${ctx.actor}`),
    )
      .set(
        artifactInboxRow(
          res.artifactId,
          'invited',
          res.joined
            ? `${profile.name} now has access to “${res.artifact.name}”`
            : `${profile.name} declined the artifact “${res.artifact.name}”`,
          ctx,
        ),
      )
      .catch((e) => console.warn('[inviteAccept] artifact inbox row failed', e));
    return {
      boardId: ARTIFACT_INVITE_BOARD_ID,
      boardKey: ARTIFACT_INVITE_BOARD_KEY,
      artifactId: res.artifactId,
    };
  }

  if (res.readerUids) await syncReaders(res.inv.boardId, res.readerUids);
  // The inviter is told (the actor is never notified by notify itself).
  await notify('invited', null, ctx, {
    boardId: res.inv.boardId,
    inviteId,
    recipients: [res.inv.invitedBy],
    summary: res.joined
      ? `${profile.name} joined ${res.board.name}`
      : `${profile.name} declined the invite to ${res.board.name}`,
  }).catch((e) => console.warn('[inviteAccept] notify failed', e));

  return { boardId: res.inv.boardId, boardKey: res.board.key };
});
