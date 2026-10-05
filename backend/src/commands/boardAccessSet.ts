/**
 * boardAccessSet — change roles, remove people, set commenters' stage grants,
 * or leave. can(admin), except `leave`, which anyone on the board may do.
 *
 *   AT LEAST ONE ADMIN MUST REMAIN → 409 (a board nobody can administer is
 *   unrecoverable: there is nothing above the board to fix it).
 *
 * A removed person: access / readerUids / editorUids / members/{uid} /
 * prefs/{uid} go in one transaction; then the RTDB mirror, then they are
 * taken off assigneeUids and watcherUids of the board's active tickets
 * (each listed in the ticket's activity), and told by e-mail. Their
 * messages stay. New people are never added here — that is invites.
 */
import {
  errors,
  isAgentId,
  paths,
  type BoardRole,
  type CommandReqParsed,
  type StageGrant,
  type Uid,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { typedDoc } from '../runtime/converters.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import {
  adminCount,
  appUrl,
  boardRef,
  deriveAccess,
  detachPeople,
  loadBoard,
  memberRef,
  profileOf,
  revokeBoardTokens,
  syncReaders,
} from './boardShared.js';

type Input = CommandReqParsed<'boardAccessSet'>;

export async function applyAccess(ctx: ServerCtx, input: Input): Promise<{ removed: Uid[] }> {
  const { boardId, people, stageGrants, leave } = input;
  // §AA2 — an agent may be a board ADMIN now, so can(admin) alone no longer
  // says "a person". What an agent admin still cannot do is what no agent
  // can: manage the board's people (nor "leave": an agent is taken off a board by a person, with boardAgentSet). Refused here by who is acting, whatever the role.
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot manage board members');
  if (leave && (people || stageGrants))
    throw errors.invalid('`leave` cannot be combined with other changes');
  if (!leave && !people && !stageGrants) throw errors.invalid('Nothing to change');

  const { removed, readerUids, boardName } = await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, leave ? 'read' : 'admin');
    const access: Record<Uid, BoardRole> = { ...board.access };
    const grants: Record<Uid, StageGrant> = { ...board.stageGrants };
    const removed: Uid[] = [];
    const touched = new Set<Uid>();

    if (leave) {
      delete access[ctx.actor];
      removed.push(ctx.actor);
    }
    // Agents have their own command (boardAgentSet: added without an invite).
    const agentIds = [...Object.keys(people ?? {}), ...Object.keys(stageGrants ?? {})].filter(
      isAgentId,
    );
    if (agentIds.length)
      throw errors.invalid('Agents are managed with boardAgentSet', { uids: agentIds });
    for (const [uid, role] of Object.entries(people ?? {})) {
      if (!(uid in board.access))
        throw errors.invalid('That person is not on this board — invite them instead', { uid });
      if (role === null) {
        delete access[uid];
        removed.push(uid);
      } else if (access[uid] !== role) {
        access[uid] = role;
        touched.add(uid);
      }
    }
    if (adminCount(access) === 0)
      throw errors.conflict(
        leave
          ? 'You are the last admin — make someone else admin first (or delete the board)'
          : 'A board needs at least one admin',
      );

    // Grants belong to commenters only: removed people and ex-commenters lose theirs.
    for (const uid of Object.keys(grants)) {
      if (access[uid] !== 'commenter') {
        delete grants[uid];
        touched.add(uid);
      }
    }
    const stageIds = new Set(board.stages.map((s) => s.id));
    for (const [uid, g] of Object.entries(stageGrants ?? {})) {
      if (!(uid in access)) throw errors.invalid('That person is not on this board', { uid });
      if (g === null) {
        delete grants[uid];
      } else {
        if (access[uid] !== 'commenter')
          throw errors.invalid('Stage grants are for commenters only', { uid });
        const bad = g.stages.filter((s) => !stageIds.has(s));
        if (bad.length) throw errors.invalid('Unknown stage ids', { stageIds: bad });
        grants[uid] = g;
      }
      touched.add(uid);
    }

    const derived = deriveAccess(access);
    tx.update(boardRef(boardId), { access, stageGrants: grants, ...derived });
    for (const uid of removed) {
      tx.delete(memberRef(boardId, uid));
      tx.delete(typedDoc('prefs', paths.pref(boardId, uid)));
      touched.delete(uid);
    }
    for (const uid of touched)
      tx.set(
        memberRef(boardId, uid),
        { role: access[uid]!, stageGrant: grants[uid] ?? null },
        { merge: true },
      );
    return { removed, readerUids: derived.readerUids, boardName: board.name };
  });

  await syncReaders(boardId, readerUids);
  await detachPeople(boardId, removed, ctx);
  // Their tokens for this board stop working (including ones acting as their
  // agents): a token never outlives its creator's seat on the board.
  for (const uid of removed)
    await revokeBoardTokens(uid, boardId, ctx.now).catch((e) =>
      console.warn('[boardAccessSet] token revoke failed', e),
    );

  // Told — best effort: they can no longer see the board, so no inbox row.
  if (!leave) {
    for (const uid of removed) {
      const p = await profileOf(uid);
      if (!p.email) continue;
      await ports()
        .email.send({
          to: p.email,
          subject: `You were removed from ${boardName}`,
          text: `You no longer have access to the board “${boardName}”.\n\n${appUrl()}/`,
          tag: 'boardRemoved',
        })
        .catch((e) => console.warn('[boardAccessSet] removal mail failed', e));
    }
  }
  return { removed };
}

export default defineCommand('boardAccessSet', async (ctx, input) => {
  await applyAccess(ctx, input);
  return { ok: true as const };
});
