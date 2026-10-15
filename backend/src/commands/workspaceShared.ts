/**
 * Shared by the workspace commands (agents.html §AB): who may (a person, for
 * themselves), and that every id they put in a workspace is something they
 * already reach — a workspace never grants anything.
 */
import { createHash } from 'node:crypto';
import {
  effectiveRole,
  errors,
  isAgentId,
  paths,
  WORKSPACES_MAX,
  type Workspace,
} from '@tm/shared';
import { db } from '../db/index.js';
import { artifactRef, roleFor } from '../artifacts/shared.js';
import { memoryRef, reachFor } from '../memory/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { runTx, txGetAll, type Tx } from '../runtime/tx.js';

export function personOnly(ctx: ServerCtx): void {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Workspaces belong to people, not agents');
}

/** 400 naming every id the caller cannot open. */
export async function assertReachable(
  tx: Tx,
  ctx: ServerCtx,
  ids: {
    boardIds?: readonly string[];
    artifactIds?: readonly string[];
    /** memory.html §F */
    memoryIds?: readonly string[];
  },
): Promise<void> {
  const boardIds = [...new Set(ids.boardIds ?? [])];
  const artifactIds = [...new Set(ids.artifactIds ?? [])];
  const [boards, artifacts] = await Promise.all([
    boardIds.length
      ? txGetAll(
          tx,
          boardIds.map((id) => typedDoc('boards', paths.board(id))),
        )
      : Promise.resolve([]),
    artifactIds.length ? txGetAll(tx, artifactIds.map(artifactRef)) : Promise.resolve([]),
  ]);
  const badBoards = boardIds.filter((_, i) => {
    const b = boards[i];
    return !b || !effectiveRole(b, ctx.actor);
  });
  const badArtifacts = artifactIds.filter((_, i) => {
    const a = artifacts[i];
    return !a || !roleFor({ ...ctx, scopes: undefined }, a);
  });
  const memoryIds = [...new Set(ids.memoryIds ?? [])];
  const memories = memoryIds.length ? await txGetAll(tx, memoryIds.map(memoryRef)) : [];
  const reaches = await Promise.all(
    memories.map((m) => reachFor({ ...ctx, scopes: undefined }, m, tx)),
  );
  const badMemories = memoryIds.filter((_, i) => !reaches[i]);
  if (badBoards.length || badArtifacts.length || badMemories.length)
    throw errors.invalid('You cannot open some of these', {
      ...(badBoards.length ? { boardIds: badBoards } : {}),
      ...(badArtifacts.length ? { artifactIds: badArtifacts } : {}),
      ...(badMemories.length ? { memoryIds: badMemories } : {}),
    });
}

/** Ordered, de-duplicated. */
export const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

// ─── sharing a workspace (one-shot): the recipient's sidebar copy ───────────

/** What a recipient's copy carries over — the grouping, never any access. */
export type WorkspaceCopy = Pick<
  Workspace,
  'name' | 'color' | 'indicator' | 'description' | 'boardIds' | 'artifactIds' | 'memoryIds'
>;

/**
 * _workspaceOffers/{id}: a copy waiting for an address that has no account
 * yet; onUserCreated turns it into a workspace (server-only, like every `_`).
 */
export const WORKSPACE_OFFERS = '_workspaceOffers';

/** The same share again updates the same copy instead of adding another. */
export const copyIdFor = (ownerUid: string, workspaceId: string): string =>
  `s_${createHash('sha256').update(`${ownerUid}\n${workspaceId}`).digest('hex').slice(0, 24)}`;

/** Write (or refresh) the copy under users/{uid}. 'full' when they are at the limit. */
export async function placeWorkspaceCopy(
  uid: string,
  copyId: string,
  copy: WorkspaceCopy,
  now: number,
): Promise<'copied' | 'full'> {
  return runTx(async (tx) => {
    const ref = typedDoc('workspaces', paths.workspace(uid, copyId));
    const [mine, existing] = await Promise.all([
      tx.get(typedCol('workspaces', paths.workspaces(uid))),
      tx.get(ref),
    ]);
    if (existing.exists) {
      tx.update(ref, { ...stripUndefined(copy), updatedAt: now });
      return 'copied';
    }
    if (mine.size >= WORKSPACES_MAX) return 'full';
    const last = Math.max(-1, ...mine.docs.map((d) => d.data().position));
    tx.create(ref, {
      ...stripUndefined(copy),
      position: last + 1,
      createdAt: now,
      updatedAt: now,
    } as Workspace);
    return 'copied';
  });
}

export const stripUndefined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** onUserCreated: every copy offered to this (verified) address becomes theirs. */
export async function claimWorkspaceOffers(uid: string, email: string, now: number): Promise<void> {
  const offers = await db().collection(WORKSPACE_OFFERS).where('email', '==', email).get();
  for (const o of offers.docs) {
    const d = o.data() as { copyId: string; copy: WorkspaceCopy };
    try {
      await placeWorkspaceCopy(uid, d.copyId, d.copy, now);
      await o.ref.delete();
    } catch (e) {
      console.error(`[workspaceShare] offer ${o.id} for ${uid} not placed`, e);
    }
  }
}
