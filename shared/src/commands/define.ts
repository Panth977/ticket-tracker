/**
 * The command contract: what every door (/api, /v1, MCP, hooks) calls.
 * A command is `handler(ctx, req) → res`; this file defines the ctx, the
 * permission vocabulary and the spec shape the registry is built from.
 */
import { z } from 'zod';
import type { AppErrorCode } from '../errors.js';
import type { BoardId, Millis, PrincipalId, Scope, Uid, Via } from '../types/index.js';

/**
 * What can() is asked (app/backend.json proxyFunctions.can). Implemented in
 * shared/src/logic; the vocabulary is a contract.
 */
export const ACTIONS = [
  'read',
  'comment',
  'create',
  'edit',
  'move',
  'state',
  'restore',
  'delete',
  'pin',
  'admin',
  /** Phase 2: change a ticket's assignees (editor+; scope tickets:assign). */
  'assign',
  /** Phase 2: upload a file onto a ticket (whoever may comment; scope files:write). */
  'upload',
  /** Phase 3 (§L1): ask a question in a thread, and cancel one (scope questions:write). */
  'ask',
  /** Phase 3 (§L1): answer a question — commenter+, and in its `to` when set (scope questions:write). */
  'answer',
  /** Phase 3 (§L2): create, replace or tick a task list — editor+, or its owner (scope tasklists:write). */
  'tasklist',
  /** Phase 3 (§L3): write an agent's heartbeat status (scope status:write). */
  'status',
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Who is acting and through which door. Built by the door's middleware:
 *   user              → { actor: uid, via: 'app' }
 *   apiKey (as me)    → { actor: owner uid, ownerUid: owner, via: 'api' | 'mcp', scopes, boardIds: [boardId], keyId, keyName }
 *   apiKey (as agent) → { actor: agentId, ownerUid: agent's owner, via: 'api' | 'mcp', scopes, boardIds: [boardId], keyId, keyName }
 *   agent token (§AA1)→ { actor: agentId, ownerUid: agent's owner, via: 'api' | 'mcp', scopes: AGENT_TOKEN_SCOPES, boardIds: null, defaultBoardId?, keyId, keyName }
 *   oauth             → { actor, via: 'mcp' | 'integration', scopes, clientName }
 * Scopes and boardIds only ever NARROW what the actor's board role allows.
 */
export interface CommandCtx {
  /**
   * The PRINCIPAL the change is authored by: a uid, or an agent id ('ag_…')
   * when a token acts as an agent (isAgentId tells them apart).
   */
  actor: PrincipalId;
  /**
   * The PERSON answerable for the request: equals `actor` for people; the
   * agent's owner for agent tokens. Idempotency records, rate limits and
   * audit use it. Absent = actor.
   */
  ownerUid?: Uid;
  /** The API key's doc id (users/{ownerUid}/apiKeys/{keyId}) when a key authenticated the request. */
  keyId?: string;
  via: Via;
  /** Verified sign-in email (inviteAccept compares it to the invite). */
  email?: string | null;
  emailVerified?: boolean;
  /** Absent = full user session (no narrowing). */
  scopes?: readonly Scope[];
  /** null / absent = every board the actor is on. */
  boardIds?: readonly BoardId[] | null;
  /**
   * §AA1 — an AGENT token converted from a board token (§AA6): the board it
   * used to be for. It narrows NOTHING (can() never reads it). Its one use:
   * when a call needs a board, names none, and the agent is on more than one,
   * this is the board meant — so what ran before the conversion still runs.
   */
  defaultBoardId?: BoardId | null;
  /** The token's name: 'Builder (agent) via token orch-eng-builder' → stamped as viaToken. */
  keyName?: string;
  /** 'Panth via Claude (MCP)' */
  clientName?: string;
  /** Request time — commands never call Date.now() themselves (tests pin it). */
  now: Millis;
  /** Correlation id for logs / problem `instance`. */
  requestId?: string;
}

/**
 * The actor of tickets that arrive from OUTSIDE the board — the intake widget
 * (via 'intake') and email-to-board (via 'email'). It is on no board: those
 * doors authorise the request themselves (intake secret / intake address) and
 * ticketCreate accepts this actor without can(), only through those vias.
 */
export const INTAKE_ACTOR = 'intake-bot';
export const INTAKE_VIAS: readonly Via[] = ['intake', 'email'];
export const isIntakeActor = (ctx: Pick<CommandCtx, 'actor' | 'via'>): boolean =>
  ctx.actor === INTAKE_ACTOR && INTAKE_VIAS.includes(ctx.via);

/** Idempotency: every request may carry one; a retried request is one change. */
export const ClientIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Request object helper: strict (unknown keys are a 400, not silently
 * dropped) and always accepts an optional clientId.
 */
export function req<T extends z.ZodRawShape>(shape: T) {
  return z.object({ clientId: ClientIdSchema.optional(), ...shape }).strict();
}

/** Response for commands whose only answer is 'done'. */
export const OkResSchema = z.object({ ok: z.literal(true) });
export type OkRes = z.infer<typeof OkResSchema>;

/**
 * Which spec names it: app/platform = docs/data/{app,platform}/backend.json;
 * 'phase2' = docs/plan/agents.html §A–K; 'phase3' = the same file's §L;
 * 'extra' = added here, implied but not named by any spec.
 */
export type CommandSource = 'app' | 'platform' | 'phase2' | 'phase3' | 'extra';

export interface CommandSpec<
  N extends string = string,
  Req extends z.ZodTypeAny = z.ZodTypeAny,
  Res extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: N;
  req: Req;
  res: Res;
  /** Who may call it, in words — the check itself lives in the handler via can(). */
  permission: string;
  /** Error codes this command can answer with (beyond unauthenticated / invalid / internal). */
  errors: readonly AppErrorCode[];
  /** Which spec file names it; 'extra' = added here, not in docs/data. */
  source: CommandSource;
  /**
   * Scopes that let a TOKEN (API key / OAuth) call it at all: ANY one of them.
   * Absent / empty = app-only, never reachable with a token. The handler then
   * checks the precise scopes the request needs (e.g. patchScopes for
   * ticketUpdate) together with can().
   */
  scopes?: readonly Scope[];
}

/**
 * PHASE 10 (§R1) — THE DENY LIST. What NO token may ever do, whatever its
 * scopes and whatever kind it is. Most of these carry no `scopes` anyway, so
 * they are already app-only; the list says so OUT LOUD and is checked by
 * name, so that giving a command a scope later can never quietly open one of
 * them. The point, in the spec's words: "a token can never mint another
 * token, so a leak cannot become permanent."
 *
 *   apiKeyCreate / apiKeyRevoke  minting or killing tokens
 *   grantRevoke                  granting or revoking OAuth access
 *   sessionRevokeAll             sign-in / session control
 *   accountDelete / accountExport  the account itself
 *   profileUpdate, whatsappLink, icsFeedUrl  profile and security settings
 *     (the verified number notifications go to, the private calendar URL)
 */
export const TOKEN_DENIED_COMMANDS = [
  'apiKeyCreate',
  'apiKeyRevoke',
  'grantRevoke',
  'sessionRevokeAll',
  'accountDelete',
  'accountExport',
  'profileUpdate',
  'whatsappLink',
  'icsFeedUrl',
] as const;
export type TokenDeniedCommand = (typeof TOKEN_DENIED_COMMANDS)[number];
const DENIED: ReadonlySet<string> = new Set(TOKEN_DENIED_COMMANDS);
/** Is this command on the hard deny list (no scope can grant it)? */
export const tokenDenied = (name: string): boolean => DENIED.has(name);

/**
 * The runner's token gate: may a request carrying `scopes` reach this
 * command? A full app session (scopes absent) always may — except that the
 * deny list is checked first, so a token is refused even if someone gives one
 * of those commands a scope by mistake.
 */
export function tokenMayCall(
  spec: Pick<CommandSpec, 'scopes'> & { name?: string },
  scopes: readonly Scope[] | undefined | null,
): boolean {
  if (spec.name && tokenDenied(spec.name) && scopes) return false;
  if (!scopes) return true;
  return !!spec.scopes?.length && spec.scopes.some((s) => scopes.includes(s));
}

/** The person answerable for a ctx (ownerUid, else the actor). */
export const ctxOwner = (ctx: Pick<CommandCtx, 'actor' | 'ownerUid'>): Uid =>
  ctx.ownerUid ?? ctx.actor;

export function defineCommand<N extends string, Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(
  spec: CommandSpec<N, Req, Res>,
): CommandSpec<N, Req, Res> {
  return spec;
}
