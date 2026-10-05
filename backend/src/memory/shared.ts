/**
 * MEMORY (docs/plan/memory.html) — what every memory command, the file door,
 * REST/MCP and the delete job share. Not a command (lives outside commands/).
 *
 *   memoryRef / nodeRef / nodesCol   typed references
 *   boardRolesFor                     the caller's roles on the GRANTED boards
 *   reachFor / loadMemory             WHO IS THIS, HERE — memoryReach() decides
 *   toMemoryOut / toNodeOut           the API shapes
 *
 * A memory's people are its own (§B). Boards reach it only through a grant
 * stored on it (§D); agents only ever through a board (D-M4).
 *
 * TOKENS. The runner has already checked memory:read / memory:write. A board
 * token acting as a person (issued for one board) reaches no memory, like an
 * artifact: it was not issued for one. Account tokens, OAuth grants and agent
 * tokens reach what memoryReach answers.
 *
 * NO REACH IS A 404, NOT A 403: a memory is private, and "you may not" would
 * confirm that the id exists.
 */
import {
  can,
  COLLECTIONS,
  effectiveRole,
  errors,
  isAgentId,
  memoryCan,
  memoryReach,
  type Board,
  type BoardRole,
  type Memory,
  type MemoryNode,
  type MemoryNodeOut,
  type MemoryOut,
  type MemoryReach,
  type MemoryRole,
  type Uid,
} from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { txGet, type Tx } from '../runtime/tx.js';
import { boardRef } from '../tickets/access.js';

const C = COLLECTIONS;

export const memoryPath = (memoryId: string) => `${C.memories}/${memoryId}`;
export const nodesPath = (memoryId: string) => `${memoryPath(memoryId)}/${C.nodes}`;

export const memoriesCol = () => typedCol('memories', C.memories);
export const memoryRef = (memoryId: string) => typedDoc('memories', memoryPath(memoryId));
export const nodesCol = (memoryId: string) => typedCol('memoryNodes', nodesPath(memoryId));
export const nodeRef = (memoryId: string, nodeId: string) =>
  typedDoc('memoryNodes', `${nodesPath(memoryId)}/${nodeId}`);
/** Untyped, for FieldValue.increment on the stats (the converter cannot check sentinels nested). */
export const rawMemoryRef = (memoryId: string) => db().doc(memoryPath(memoryId));

export type MemoryNeed = 'read' | 'write' | 'manage';

/** A board-scoped API key acting as its person (keyId set, narrowed to boards). */
export const isBoardTokenAsPerson = (
  ctx: Pick<ServerCtx, 'actor' | 'keyId' | 'boardIds'>,
): boolean =>
  !isAgentId(ctx.actor) && !!ctx.keyId && ctx.boardIds !== null && ctx.boardIds !== undefined;

/**
 * The caller's role on each GRANTED board (only those matter to memoryReach).
 * can(read) decides whether a role counts at all: it applies §AA1 (an agent
 * reaches a board only while its owner is on it) and a token's board narrowing.
 * Scopes are not asked here — the runner checked the memory scopes already.
 */
export async function boardRolesFor(
  ctx: Pick<ServerCtx, 'actor' | 'ownerUid' | 'boardIds'>,
  memory: Pick<Memory, 'boards'>,
  tx?: Tx,
): Promise<Map<string, BoardRole>> {
  const ids = Object.keys(memory.boards ?? {});
  const out = new Map<string, BoardRole>();
  if (!ids.length) return out;
  const docs = await Promise.all(
    ids.map((id) =>
      tx
        ? txGet(tx, boardRef(id))
        : boardRef(id)
            .get()
            .then((s) => s.data()),
    ),
  );
  const canCtx = { actor: ctx.actor, ownerUid: ctx.ownerUid, boardIds: ctx.boardIds };
  docs.forEach((b, i) => {
    if (!b || b.archivedAt != null) return;
    const board = { ...b, id: ids[i]! };
    if (!can(canCtx, board, 'read')) return;
    const role = effectiveRole(board, ctx.actor);
    if (role) out.set(board.id, role);
  });
  return out;
}

/** What the caller may do in this memory (null = nothing; answer 404). */
export async function reachFor(
  ctx: ServerCtx,
  memory: Memory | undefined,
  tx?: Tx,
): Promise<MemoryReach> {
  if (!memory || memory.deletingAt) return null;
  if (isBoardTokenAsPerson(ctx)) return null;
  const agent = isAgentId(ctx.actor);
  // An agent never holds a role on a memory (D-M4): only boards count for it.
  const uid = agent ? null : ctx.actor;
  const needsBoards =
    agent ||
    !uid ||
    !Object.prototype.hasOwnProperty.call(memory.access, uid) ||
    memory.access[uid] !== 'owner';
  const boardRoles = needsBoards ? await boardRolesFor(ctx, memory, tx) : new Map();
  return memoryReach(memory, { uid, boardRoles });
}

const REFUSAL: Record<MemoryNeed, string> = {
  read: 'You cannot open this memory',
  write: 'You can read this memory but not change it',
  manage: 'Only the owner of this memory can do that',
};

export interface LoadedMemory {
  memory: Memory;
  reach: Exclude<MemoryReach, null>;
}

/** Read a memory (in `tx` when given) and gate it: 404 without reach, 403 with too little. */
export async function loadMemory(
  tx: Tx | null,
  memoryId: string,
  ctx: ServerCtx,
  need: MemoryNeed,
): Promise<LoadedMemory> {
  const ref = memoryRef(memoryId);
  const memory = tx ? await txGet(tx, ref) : (await ref.get()).data();
  const reach = await reachFor(ctx, memory, tx ?? undefined);
  if (!memory || !reach) {
    if (memory && isBoardTokenAsPerson(ctx) && memory.access[ctx.actor])
      throw errors.forbidden(
        'A board token cannot reach memory — use an account token (Account › Tokens)',
      );
    throw errors.not_found('Memory not found');
  }
  const ok =
    need === 'read'
      ? memoryCan.read(reach)
      : need === 'write'
        ? memoryCan.write(reach)
        : memoryCan.manage(reach);
  // Archived is read-only for everyone, the owner included, until restored.
  if (ok && need === 'write' && memory.archivedAt !== null)
    throw errors.conflict('This memory is archived — restore it first');
  if (!ok) {
    if (need === 'write' && memory.archivedAt !== null)
      throw errors.conflict('This memory is archived — restore it first');
    throw errors.forbidden(REFUSAL[need]);
  }
  return { memory, reach };
}

/** `access` with its derived list. The ONLY way memberUids is ever computed. */
export function withMembers(access: Record<Uid, MemoryRole>): {
  access: Record<Uid, MemoryRole>;
  memberUids: Uid[];
} {
  return { access, memberUids: Object.keys(access).sort() };
}

export const toMemoryOut = (
  id: string,
  m: Memory,
  reach: Exclude<MemoryReach, null>,
): MemoryOut => ({
  id,
  name: m.name,
  description: m.description,
  icon: m.icon,
  reach,
  archived: m.archivedAt !== null,
  stats: m.stats,
  updatedAt: m.updatedAt,
});

export function toNodeOut(id: string, n: MemoryNode): MemoryNodeOut {
  let file: MemoryNodeOut['file'] = null;
  if (n.file) {
    const { storagePath: _s, ...rest } = n.file;
    file = rest;
  }
  return {
    id,
    kind: n.kind,
    parentId: n.parentId,
    name: n.name,
    path: n.path,
    file,
    updatedAt: n.updatedAt,
  };
}

/** Where a person opens a memory in the app. */
export const memoryAppHref = (memoryId: string) => `/m/${memoryId}`;

/**
 * Every board the caller is on, with its role (memoryList: which granted
 * memories it reaches). People by readerUids, agents by agentIds; the same
 * can(read) filter as boardRolesFor.
 */
export async function callerBoardRoles(
  ctx: Pick<ServerCtx, 'actor' | 'ownerUid' | 'boardIds'>,
): Promise<Map<string, BoardRole>> {
  const field = isAgentId(ctx.actor) ? 'agentIds' : 'readerUids';
  const snap = await db().collection(C.boards).where(field, 'array-contains', ctx.actor).get();
  const out = new Map<string, BoardRole>();
  const canCtx = { actor: ctx.actor, ownerUid: ctx.ownerUid, boardIds: ctx.boardIds };
  for (const d of snap.docs) {
    const b = { ...(d.data() as Board), id: d.id };
    if (b.archivedAt != null || !can(canCtx, b, 'read')) continue;
    const role = effectiveRole(b, ctx.actor);
    if (role) out.set(d.id, role);
  }
  return out;
}
