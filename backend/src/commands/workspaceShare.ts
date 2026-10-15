/**
 * workspaceShare — share a workspace in one go (one-shot): every board in it
 * is an invitation, every artifact and memory a share, each made by the very
 * command that makes it alone (inviteCreate, artifactShare, memoryShare) —
 * same permissions, same limits, same e-mails. The workspace grants nothing
 * itself; items added to it later are not shared.
 *
 * The role is a board role; artifacts and memories know only editor / viewer,
 * so 'admin' is 'editor' there. What the owner cannot share (a board where
 * they may not invite, an artifact or memory they do not own) is skipped and
 * listed once.
 *
 * Each address also gets a copy of the grouping in their sidebar — now, or
 * when they sign up (an offer in _workspaceOffers, claimed by onUserCreated).
 */
import { COMMANDS, errors, isAppError, paths, type CommandName, type Workspace } from '@tm/shared';
import { artifactRef } from '../artifacts/shared.js';
import { db } from '../db/index.js';
import { memoryRef } from '../memory/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { typedDoc } from '../runtime/converters.js';
import { defineCommand, getRegisteredCommand } from './_registry.js';
import { uidForEmail } from './inviteShared.js';
import {
  copyIdFor,
  personOnly,
  placeWorkspaceCopy,
  stripUndefined,
  WORKSPACE_OFFERS,
  type WorkspaceCopy,
} from './workspaceShared.js';

/** Run another command's handler as this caller, its input parsed by its own schema. */
function run(ctx: ServerCtx, name: CommandName, input: unknown): Promise<unknown> {
  const cmd = getRegisteredCommand(name);
  if (!cmd) throw new Error(`${name} is not registered`);
  return cmd.handler(ctx, COMMANDS[name].req.parse(input));
}

const reasonOf = (e: unknown): string => {
  if (isAppError(e)) return e.message;
  throw e;
};

export default defineCommand('workspaceShare', async (ctx, input) => {
  personOnly(ctx);
  const ws = (
    await typedDoc('workspaces', paths.workspace(ctx.actor, input.workspaceId)).get()
  ).data() as Workspace | undefined;
  if (!ws) throw errors.not_found('No such workspace');

  const me = (ctx.email ?? '').toLowerCase();
  const emails = [...new Set(input.emails.map((e) => e.toLowerCase()))].filter((e) => e !== me);
  if (!emails.length) throw errors.invalid('Give at least one address other than your own');

  const counts = new Map(emails.map((e) => [e, { boards: 0, artifacts: 0, memories: 0 }]));
  const skipped: { kind: 'board' | 'artifact' | 'memory'; id: string; reason: string }[] = [];
  const sideRole = input.role === 'admin' ? 'editor' : input.role;

  // Boards: one invitation call per board, every address at once.
  for (const boardId of ws.boardIds) {
    try {
      const r = (await run(ctx, 'inviteCreate', {
        boardId,
        invites: emails.map((email) => ({ email, role: input.role })),
        ...(input.message ? { message: input.message } : {}),
      })) as { invited: string[]; alreadyOnBoard: string[] };
      for (const e of [...r.invited, ...r.alreadyOnBoard]) {
        const c = counts.get(e);
        if (c) c.boards++;
      }
    } catch (e) {
      skipped.push({ kind: 'board', id: boardId, reason: reasonOf(e) });
    }
  }

  // Artifacts and memories: only their owner shares them.
  const own = async (kind: 'artifact' | 'memory', id: string): Promise<boolean> => {
    const snap = await (kind === 'artifact' ? artifactRef(id) : memoryRef(id)).get();
    const owner = (snap.data() as { ownerUid?: string } | undefined)?.ownerUid;
    if (owner === ctx.actor) return true;
    skipped.push({ kind, id, reason: snap.exists ? 'Only its owner can share it' : 'Not found' });
    return false;
  };
  for (const artifactId of ws.artifactIds) {
    if (!(await own('artifact', artifactId))) continue;
    for (const email of emails)
      try {
        await run(ctx, 'artifactShare', { artifactId, email, role: sideRole });
        counts.get(email)!.artifacts++;
      } catch (e) {
        reasonOf(e); // a per-address refusal (e.g. already the owner): not counted
      }
  }
  for (const memoryId of ws.memoryIds ?? []) {
    if (!(await own('memory', memoryId))) continue;
    for (const email of emails)
      try {
        await run(ctx, 'memoryShare', { memoryId, email, role: sideRole });
        counts.get(email)!.memories++;
      } catch (e) {
        reasonOf(e);
      }
  }

  // The grouping itself, in each recipient's sidebar.
  const copy: WorkspaceCopy = stripUndefined({
    name: ws.name,
    color: ws.color,
    indicator: ws.indicator,
    description: ws.description,
    boardIds: ws.boardIds,
    artifactIds: ws.artifactIds,
    memoryIds: ws.memoryIds ?? [],
  });
  const copyId = copyIdFor(ctx.actor, input.workspaceId);
  const shared = [];
  for (const email of emails) {
    const uid = await uidForEmail(email);
    let workspace: 'copied' | 'pending' | 'full';
    if (uid) workspace = await placeWorkspaceCopy(uid, copyId, copy, ctx.now);
    else {
      await db()
        .collection(WORKSPACE_OFFERS)
        .doc(`${copyId}_${Buffer.from(email).toString('base64url').slice(0, 80)}`)
        .set({ email, copyId, copy, from: ctx.actor, createdAt: ctx.now });
      workspace = 'pending';
    }
    shared.push({ email, ...counts.get(email)!, workspace });
  }
  return { shared, skipped };
});
