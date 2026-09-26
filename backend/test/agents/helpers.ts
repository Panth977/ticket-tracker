/**
 * Agent fixtures for the emulator tests.
 *
 *   liveStatus / liveRev / liveWake / liveSilence   read the RTDB live tree (§W)
 *   makeAgent(owner, boardId?, role?)  agentCreate (+ boardAgentSet) through /api as the owner
 *   asAgent(agent, cmd, input, opts)   run a command AS the agent, the way a token acting as
 *                                      it will (actor = agentId, ownerUid, via 'api', scopes,
 *                                      boardIds, keyName). The token door is p2-api's; this
 *                                      applies the same gate (tokenMayCall) and zod parsing
 *                                      the runner does, then calls the handler.
 *   seedAgentToken(owner, agent, boardId)  a users/{owner}/apiKeys row acting as the agent
 */
import {
  errors,
  live,
  paths,
  SCOPE_PRESETS,
  tokenMayCall,
  type AgentStatus,
  type ApiKey,
  type BoardRev,
  type CommandName,
  type CommandReq,
  type CommandRes,
  type Scope,
  type Via,
} from '@tm/shared';
import { getRegisteredCommand } from '../../src/commands/_registry.js';
import { autoload } from '../../src/runtime/autoload.js';
import { db, rtdbAdmin } from '../../src/runtime/firebase.js';
import { makeCtx } from '../../src/runtime/context.js';
import { readStatus } from '../../src/platform/rtdbPaths.js';
import { call, uniq, type TestUser } from '../harness/index.js';

// ─── the live tree (docs/plan/agents.html §W) ────────────────────────────────

/** One beat stream, in the AgentStatus shape everything above the RTDB speaks. */
export const liveStatus = (
  boardId: string,
  agentId: string,
  ticketId: string | null = null,
): Promise<AgentStatus | null> => readStatus(boardId, agentId, ticketId);

/** The raw node, so a test can assert what is and is NOT stored. */
export const liveStatusNode = async (
  boardId: string,
  agentId: string,
  ticketId: string | null = null,
): Promise<Record<string, unknown> | null> =>
  (
    await rtdbAdmin()
      .ref(live.status(boardId, agentId, ticketId))
      .get()
  ).val() as Record<string, unknown> | null;

export const liveRev = async (boardId: string): Promise<BoardRev | null> =>
  (await rtdbAdmin().ref(live.rev(boardId)).get()).val() as BoardRev | null;

export const liveWake = async (agentId: string): Promise<{ at: number; boardId?: string } | null> =>
  (await rtdbAdmin().ref(live.wake(agentId)).get()).val() as {
    at: number;
    boardId?: string;
  } | null;

export const liveSilence = async (
  boardId: string,
  agentId: string,
  ticketId: string | null = null,
): Promise<{ notifiedAt: number } | null> =>
  (
    await rtdbAdmin()
      .ref(live.silence(boardId, agentId, ticketId))
      .get()
  ).val() as {
    notifiedAt: number;
  } | null;

export interface TestAgent {
  id: string;
  ownerUid: string;
  name: string;
}

export async function makeAgent(
  owner: TestUser,
  opts: {
    name?: string;
    boardId?: string;
    role?: 'editor' | 'commenter' | 'viewer';
    description?: string;
    icon?: string;
  } = {},
): Promise<TestAgent> {
  const name = opts.name ?? 'Builder';
  const { agentId } = await call(owner, 'agentCreate', {
    name,
    systemPrompt: '# You build things',
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.icon ? { icon: opts.icon as never } : {}),
  });
  if (opts.boardId)
    await call(owner, 'boardAgentSet', {
      boardId: opts.boardId,
      agentId,
      role: opts.role ?? 'editor',
    });
  return { id: agentId, ownerUid: owner.uid, name };
}

export interface AsAgentOptions {
  scopes?: readonly Scope[];
  boardIds?: readonly string[] | null;
  keyName?: string;
  via?: Via;
  now?: number;
}

export async function asAgent<N extends CommandName>(
  agent: TestAgent,
  command: N,
  input: CommandReq<N>,
  opts: AsAgentOptions = {},
): Promise<CommandRes<N>> {
  await autoload();
  const cmd = getRegisteredCommand(command);
  if (!cmd) throw new Error(`no command ${command}`);
  const ctx = makeCtx({
    actor: agent.id,
    ownerUid: agent.ownerUid,
    via: opts.via ?? 'api',
    scopes: opts.scopes ?? SCOPE_PRESETS.everything,
    boardIds: opts.boardIds ?? null,
    keyName: opts.keyName ?? 'orch-test',
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (!tokenMayCall(cmd.spec, ctx.scopes))
    throw errors.forbidden(`"${command}" is not available to API tokens`);
  const parsed = cmd.spec.req.parse(input ?? {});
  const out = await cmd.handler(ctx, parsed);
  return cmd.spec.res.parse(out) as CommandRes<N>;
}

/** A token row acting as the agent on one board (what apiKeyCreate will write). */
export async function seedAgentToken(
  owner: TestUser,
  agent: TestAgent,
  boardId: string,
  kind: 'agent' | 'user' = 'agent',
): Promise<string> {
  const keyId = uniq('k');
  const key: ApiKey = {
    name: `orch-${keyId}`,
    kind: 'board',
    boardId,
    actsAs: kind === 'agent' ? { kind: 'agent', id: agent.id } : { kind: 'user', id: owner.uid },
    scopes: [...SCOPE_PRESETS.worker],
    prefix: 'tm_live_abcd',
    hash: uniq('h'),
    limits: { perMin: 60, perDay: 10_000 },
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedReason: null,
    createdAt: Date.now(),
  };
  await db().doc(paths.apiKey(owner.uid, keyId)).set(key);
  return keyId;
}

export async function apiKeyOf(owner: TestUser, keyId: string): Promise<ApiKey> {
  return (await db().doc(paths.apiKey(owner.uid, keyId)).get()).data() as ApiKey;
}
