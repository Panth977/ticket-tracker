/**
 * Agent profiles and agents on boards (docs/plan/agents.html §B, §C) — the
 * pieces the agent commands and boardAgentSet share.
 *
 *   agentRef / loadOwnAgent      agents/{agentId}; only the owner sees it (404 otherwise)
 *   newAgentIdFrom               'ag_' + 16 from the ctx id generator
 *   checkAgentAvatar             users/{owner}/agents/{agentId}/avatar/…, exists, image, ≤ 5 MB
 *   agentMemberDoc               members/{agentId} for a board
 *   agentBoardIds                every board the agent is on (collectionGroup members)
 *   removeAgentFromBoard         the ONE removal path (boardAgentSet role:null, agentArchive)
 *   revokeAgentTokens            users/{owner}/apiKeys acting as the agent (optionally one board)
 *   fanOutAgentToMembers         name / avatar / icon / description → every members/{agentId}
 *
 * Agents never sign in: they are never in readerUids / editorUids (deriveAccess
 * leaves 'ag_' ids out) and never in the RTDB boardReaders mirror. §AA1: they
 * ARE in the board's derived `agentIds`, which is how an agent token finds
 * the boards its agent is on.
 */
import {
  COLLECTIONS,
  errors,
  isAgentId,
  MAX_AVATAR_BYTES,
  newAgentId,
  paths,
  storage,
  type Agent,
  type AgentBoardRole,
  type ApiKey,
  type BoardMember,
  type StageGrant,
  type Uid,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import {
  boardRef,
  deriveAccess,
  detachPeople,
  inBatches,
  memberRef,
} from '../commands/boardShared.js';
import type { ServerCtx } from '../runtime/context.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { runTx, txGet, type Tx } from '../runtime/tx.js';

/** 50 live (not archived) agents per person. */
export const MAX_AGENTS_PER_OWNER = 50;

export const agentRef = (agentId: string) => typedDoc('agents', paths.agent(agentId));

/**
 * Agent commands are person-only: an agent never manages agents. KEPT under
 * §AA2 — being a board admin does not make an agent able to create, edit or
 * archive agent profiles.
 */
export function requirePerson(ctx: Pick<ServerCtx, 'actor'>): Uid {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot manage agents');
  return ctx.actor;
}

/** A fresh agent id from the ctx id generator (deterministic under seqIds). */
export function newAgentIdFrom(ctx: Pick<ServerCtx, 'ids'>): string {
  const id = `ag_${ctx.ids
    .id()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 16)}`;
  return isAgentId(id) ? id : newAgentId();
}

/**
 * The agent, when `ownerUid` owns it — otherwise 404 exactly like a missing
 * one: agents are private, their existence is not leaked.
 */
export async function loadOwnAgent(agentId: string, ownerUid: Uid, tx?: Tx): Promise<Agent> {
  const ref = agentRef(agentId);
  const data = tx ? await txGet(tx, ref) : (await ref.get()).data();
  if (!data || data.ownerUid !== ownerUid) throw errors.not_found('Agent not found');
  return data;
}

/**
 * An agent's picture: under users/{owner}/agents/{agentId}/avatar/ (one level),
 * already uploaded, an image, at most 5 MB — the same checks as profileUpdate.
 */
export async function checkAgentAvatar(
  path: string,
  ownerUid: Uid,
  agentId: string,
): Promise<void> {
  const prefix = storage.agentAvatarPrefix(ownerUid, agentId);
  if (
    !path.startsWith(prefix) ||
    path.length === prefix.length ||
    path.slice(prefix.length).includes('/')
  )
    throw errors.invalid(`avatarPath must be under ${prefix}`, { field: 'avatarPath' });
  const obj = await ports().files.stat(path);
  if (!obj) throw errors.invalid('Upload the picture first', { field: 'avatarPath' });
  if (!obj.contentType.startsWith('image/'))
    throw errors.invalid('The picture must be an image', { field: 'avatarPath' });
  if (obj.size > MAX_AVATAR_BYTES)
    throw errors.invalid('The picture is larger than 5 MB', { field: 'avatarPath' });
}

/** members/{agentId}: how the board's pickers show the agent. */
export function agentMemberDoc(
  agentId: string,
  agent: Pick<Agent, 'ownerUid' | 'name' | 'avatarPath' | 'icon' | 'description'>,
  role: AgentBoardRole,
  stageGrant: StageGrant | null,
  addedBy: Uid,
  now: number,
): BoardMember {
  return {
    kind: 'agent',
    uid: agentId,
    role,
    stageGrant: role === 'commenter' ? stageGrant : null,
    name: agent.name,
    email: '',
    avatarPath: agent.avatarPath,
    icon: agent.icon ?? null,
    invitedBy: null,
    ownerUid: agent.ownerUid,
    addedBy,
    description: agent.description,
    joinedAt: now,
  };
}

/** Every board the agent is on (members/{agentId} rows, found by their `uid` field). */
export async function agentBoardIds(agentId: string): Promise<string[]> {
  const snap = await db().collectionGroup(COLLECTIONS.members).where('uid', '==', agentId).get();
  return snap.docs.map((d) => d.ref.parent.parent!.id);
}

/**
 * Copy the agent's display fields onto every members/{agentId} row, the same
 * way a person's profile change reaches their boards.
 */
export async function fanOutAgentToMembers(
  agentId: string,
  patch: Partial<Pick<BoardMember, 'name' | 'avatarPath' | 'icon' | 'description'>>,
): Promise<number> {
  if (Object.keys(patch).length === 0) return 0;
  const snap = await db().collectionGroup(COLLECTIONS.members).where('uid', '==', agentId).get();
  await inBatches(snap.docs, (b, d) => b.update(d.ref, patch));
  return snap.size;
}

/**
 * Revoke the tokens that act as this agent — every one (boardId null: the
 * agent was archived), or only the LEGACY board tokens for `boardId` (the
 * agent left that board).
 *
 * §AA1 — A §AA AGENT TOKEN BELONGS TO THE AGENT, NOT TO A BOARD: it has
 * boardId null, so the per-board form never matches it and leaving one board
 * leaves it alone (that board simply becomes a 404 for it). A converted
 * token's defaultBoardId is not a board it is "for" either — it is only a
 * default, and resolve.ts stops using it once the agent is off that board.
 * Archiving the agent still revokes everything.
 *
 * Tokens live under their creator; only the agent's owner can create one
 * acting as it (apiKeyCreate), so the owner's collection is where to look.
 * Already-revoked tokens keep their original reason.
 */
export async function revokeAgentTokens(
  ownerUid: Uid,
  agentId: string,
  boardId: string | null,
  reason: NonNullable<ApiKey['revokedReason']>,
  now: number,
): Promise<number> {
  const snap = await typedCol('apiKeys', paths.apiKeys(ownerUid))
    .where('actsAs.id', '==', agentId)
    .get();
  const live = snap.docs.filter((d) => {
    const k = d.data();
    return k.revokedAt === null && (boardId === null || k.boardId === boardId);
  });
  await inBatches(live, (b, d) => b.update(d.ref, { revokedAt: now, revokedReason: reason }));
  return live.length;
}

/**
 * Take an agent off a board — THE removal path, shared by boardAgentSet
 * (role:null, any admin) and agentArchive (the owner, from every board).
 * In one transaction: access, stageGrants, agentIds and members/{agentId}.
 * Then, like a removed person: off assignees and watchers of active tickets
 * (its messages stay), and its LEGACY board tokens for this board are revoked
 * — never its §AA1 agent token (see revokeAgentTokens).
 *
 * `gate` runs inside the transaction (permission checks). `removed` is false
 * when the agent was not on the board (nothing done).
 */
export async function removeAgentFromBoard(
  ctx: ServerCtx,
  boardId: string,
  agentId: string,
  reason: 'agentRemoved' | 'agentArchived',
  gate?: (tx: Tx) => Promise<void>,
): Promise<{ removed: boolean; tokensRevoked: number }> {
  const out = await runTx(async (tx) => {
    if (gate) await gate(tx);
    const board = await txGet(tx, boardRef(boardId));
    const member = await txGet(tx, memberRef(boardId, agentId));
    if (!board || !Object.prototype.hasOwnProperty.call(board.access, agentId)) {
      // A stray members/ row (should not happen) goes too.
      if (member) tx.delete(memberRef(boardId, agentId));
      return { removed: false as const, ownerUid: member?.ownerUid ?? null };
    }
    const access = { ...board.access };
    const stageGrants = { ...board.stageGrants };
    delete access[agentId];
    delete stageGrants[agentId];
    tx.update(boardRef(boardId), { access, stageGrants, ...deriveAccess(access) });
    tx.delete(memberRef(boardId, agentId));
    return { removed: true as const, ownerUid: member?.ownerUid ?? null };
  });
  if (!out.removed) return { removed: false, tokensRevoked: 0 };

  await detachPeople(boardId, [agentId], ctx);
  const ownerUid = out.ownerUid ?? (await agentRef(agentId).get()).data()?.ownerUid ?? null;
  const tokensRevoked = ownerUid
    ? await revokeAgentTokens(ownerUid, agentId, boardId, reason, ctx.now)
    : 0;
  return { removed: true, tokensRevoked };
}
