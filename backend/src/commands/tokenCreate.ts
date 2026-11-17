/**
 * tokenCreate (ORCH-73) — a token that mints a token acting as one of the
 * caller's AGENTS, so a person's own assistant (account token / OAuth grant
 * with agents:write) can wire up an orchestrator without the app.
 *
 * It is a narrow front for apiKeyCreate, which stays on TOKEN_DENIED_COMMANDS:
 * the request is rebuilt here so it can only ever be a board token acting as
 * an agent (preset board scopes, never admin) or an agent token — never an
 * account token, never one acting as the person. apiKeyCreate's handler then
 * does every ownership / board / archive check exactly as for the app. The new
 * row records which key made it (mintedByKeyId).
 */
import {
  COMMANDS,
  ctxOwner,
  errors,
  isAgentId,
  paths,
  SCOPE_PRESETS,
  type Agent,
} from '@tm/shared';
import { db } from '../runtime/firebase.js';
import { defineCommand } from './_registry.js';
import apiKeyCreate from './apiKeyCreate.js';

/** An agent of `owner` by id or exact name (case-insensitive), not archived. */
async function ownAgent(owner: string, ref: string): Promise<string> {
  const wanted: string = ref;
  if (isAgentId(ref)) return ref; // apiKeyCreate checks owner and archive
  const snap = await db().collection(paths.agents()).where('ownerUid', '==', owner).get();
  const want = wanted.trim().toLowerCase();
  const hits = snap.docs.filter((d) => {
    const a = d.data() as Agent;
    return a.archivedAt === null && a.name.trim().toLowerCase() === want;
  });
  if (!hits.length) throw errors.not_found(`No agent of yours named "${wanted}"`);
  if (hits.length > 1)
    throw errors.invalid(`Several agents are named "${wanted}" — pass the id`, { field: 'agent' });
  return hits[0]!.id;
}

export default defineCommand('tokenCreate', async (ctx, input) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot create tokens');
  const owner = ctxOwner(ctx);
  const agentId = await ownAgent(owner, input.agent);
  const board = !!input.boardId;
  if (board && input.keepOthers !== undefined)
    throw errors.invalid('keepOthers is for an agent token (no boardId)', { field: 'keepOthers' });
  if (!board && input.preset !== undefined)
    throw errors.invalid('An agent token has no preset — its role on each board decides', {
      field: 'preset',
    });

  const scopes = board ? [...SCOPE_PRESETS[input.preset ?? 'worker']] : undefined;
  const req = COMMANDS.apiKeyCreate.req.parse({
    name: input.name,
    kind: board ? 'board' : 'agent',
    ...(board ? { boardId: input.boardId, scopes } : { keepOthers: input.keepOthers ?? true }),
    actsAs: { kind: 'agent', id: agentId },
    expiresInDays: input.expiresInDays ?? null,
  });
  const res = (await apiKeyCreate.handler(ctx, req)) as {
    key: string;
    keyId: string;
    prefix: string;
    expiresAt: number | null;
    rotated?: number;
  };
  await db()
    .doc(paths.apiKey(owner, res.keyId))
    .update({ mintedByKeyId: ctx.keyId ?? null });
  const stored = await db().doc(paths.apiKey(owner, res.keyId)).get();
  return {
    key: res.key,
    keyId: res.keyId,
    prefix: res.prefix,
    kind: board ? ('board' as const) : ('agent' as const),
    agentId,
    boardId: board ? input.boardId! : null,
    scopes: (stored.data()?.scopes as never) ?? [],
    expiresAt: res.expiresAt,
    ...(res.rotated !== undefined ? { rotated: res.rotated } : {}),
  };
});
