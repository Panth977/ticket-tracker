/**
 * Helpers for the platform door tests: API keys, raw REST calls with a
 * bearer, and the OAuth dance (register → consent → token) done the way a
 * real MCP client does it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import {
  paths,
  type Agent,
  type AgentBoardRole,
  type AgentInboxEvent,
  type BoardMember,
  type Scope,
  type StageGrant,
} from '@tm/shared';
import { agentEventId } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { call, request, uniq, type RawResponse, type TestUser } from '../harness/index.js';

/** A board token (API key v2) acting as `user` on one board. */
export async function apiKeyFor(
  user: TestUser,
  scopes: Scope[],
  boardId: string,
  name = 'test key',
): Promise<{ key: string; keyId: string; prefix: string }> {
  return call(user, 'apiKeyCreate', { name, boardId, scopes });
}

/** A board token acting as one of `owner`'s agents. */
export async function agentKeyFor(
  owner: TestUser,
  agentId: string,
  scopes: Scope[],
  boardId: string,
  name = 'orch-builder',
): Promise<{ key: string; keyId: string; prefix: string }> {
  return call(owner, 'apiKeyCreate', {
    name,
    boardId,
    actsAs: { kind: 'agent', id: agentId },
    scopes,
  });
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const newAgentId = (): string =>
  'ag_' + Array.from(randomBytes(16), (b) => ALNUM[b % ALNUM.length]).join('');

/**
 * An agent profile owned by `owner`, seeded straight into Firestore (these
 * tests are about the API door, not agentCreate / boardAgentSet), optionally
 * put on a board with a role — exactly the documents boardAgentSet writes.
 */
export async function seedAgent(
  owner: TestUser,
  opts: {
    name?: string;
    systemPrompt?: string;
    boardId?: string;
    role?: AgentBoardRole;
    grant?: StageGrant;
  } = {},
): Promise<{ id: string; agent: Agent }> {
  const id = newAgentId();
  const now = Date.now();
  const agent: Agent = {
    ownerUid: owner.uid,
    name: opts.name ?? `Builder ${uniq()}`,
    avatarPath: null,
    systemPrompt: opts.systemPrompt ?? '# You are Builder\nShip small, tested changes.',
    description: 'Builds things',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  await db().doc(paths.agent(id)).set(agent);
  if (opts.boardId)
    await putAgentOnBoard(owner, id, agent.name, opts.boardId, opts.role ?? 'editor', opts.grant);
  return { id, agent };
}

export async function putAgentOnBoard(
  owner: TestUser,
  agentId: string,
  name: string,
  boardId: string,
  role: AgentBoardRole,
  grant?: StageGrant,
): Promise<void> {
  const member: BoardMember = {
    kind: 'agent',
    uid: agentId,
    role,
    stageGrant: grant ?? null,
    name,
    email: '',
    avatarPath: null,
    invitedBy: null,
    ownerUid: owner.uid,
    addedBy: owner.uid,
    description: 'Builds things',
    joinedAt: Date.now(),
  };
  const b = db().batch();
  b.update(db().doc(paths.board(boardId)), {
    [`access.${agentId}`]: role,
    ...(grant ? { [`stageGrants.${agentId}`]: grant } : {}),
  });
  b.set(db().doc(paths.member(boardId, agentId)), member);
  await b.commit();
}

export async function removeAgentFromBoard(agentId: string, boardId: string): Promise<void> {
  await db()
    .doc(paths.board(boardId))
    .update({ [`access.${agentId}`]: FieldValue.delete() });
  await db().doc(paths.member(boardId, agentId)).delete();
}

/** An inbox event, as notify() writes it for an agent recipient. */
export async function seedAgentEvent(
  agentId: string,
  e: Partial<AgentInboxEvent> & Pick<AgentInboxEvent, 'boardId' | 'ticketId' | 'ticketKey'>,
  at = Date.now(),
): Promise<string> {
  const id = agentEventId(at, randomBytes(4).toString('hex'));
  const row: AgentInboxEvent = {
    type: 'assigned',
    messageId: null,
    actor: null,
    summary: `Assigned ${e.ticketKey}`,
    createdAt: at,
    ackedAt: null,
    ...e,
  };
  await db().doc(paths.agentEvent(agentId, id)).set(row);
  return id;
}

export function rest(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return request(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

export const REDIRECT = 'https://client.example/callback';

export async function registerClient(name = 'Claude'): Promise<string> {
  const r = await request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (r.status !== 201) throw new Error(`register: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { client_id: string }).client_id;
}

/** The consent screen's Approve, as the SPA calls it; returns the code from the redirect. */
export async function consent(
  user: TestUser,
  clientId: string,
  challenge: string,
  scope: string,
  boardIds: string[] | null = null,
): Promise<string> {
  const r = await request('/oauth/consent/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
    body: JSON.stringify({
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope,
      state: 'st4te',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      approve: true,
      boardIds,
    }),
  });
  if (r.status !== 200) throw new Error(`consent: ${r.status} ${JSON.stringify(r.body)}`);
  const url = new URL((r.body as { redirect: string }).redirect);
  if (url.searchParams.get('state') !== 'st4te') throw new Error('state lost');
  return url.searchParams.get('code')!;
}

export function tokenRequest(params: Record<string, string>): Promise<RawResponse> {
  return request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
}

/** register → consent → token: an access token acting as `user`. */
export async function oauthTokens(
  user: TestUser,
  scope: string,
  boardIds: string[] | null = null,
  clientName = 'Claude',
): Promise<Tokens & { clientId: string }> {
  const clientId = await registerClient(clientName);
  const { verifier, challenge } = pkce();
  const code = await consent(user, clientId, challenge, scope, boardIds);
  const r = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  if (r.status !== 200) throw new Error(`token: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...(r.body as Tokens), clientId };
}
