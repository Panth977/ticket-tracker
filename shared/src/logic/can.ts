/**
 * can() — ONE question: may this actor do this to this board?
 * (docs/data/app/backend.json proxyFunctions.can)
 *
 * ONE LOOKUP, ONE ROLE, ONE BOARD. Nothing above the board can grant anything
 * on it. Scopes (API keys / OAuth / MCP) and boardIds only ever NARROW what the
 * role allows. Phase 2: the actor is a PRINCIPAL — a person or an agent. An
 * agent's role comes from the same access map (and its StageGrant from
 * stageGrants). §AA2: THE ROLE IS THE PERMISSION, for an agent exactly as for
 * a person — an agent may be admin, and can() no longer reads its 'admin' as
 * 'editor'. What no agent may do whatever its role (manage people and agents,
 * invite, create boards, mint tokens) is not a can() question: those commands
 * refuse an agent actor themselves. Pure: the backend handlers, the
 * security-rule tests and the UI (to hide buttons) all call this same function.
 *
 * §AA1 — AN AGENT TOKEN NEEDS NO EXTRA RULE HERE EITHER. Like an account
 * token it carries `boardIds: null`, and its fixed scopes (AGENT_TOKEN_SCOPES)
 * reach every board action, so what is left is `board.access[agentId]`.
 *
 * PHASE 10 (§R1) — AN ACCOUNT TOKEN NEEDS NO EXTRA RULE HERE. It carries
 * `boardIds: null`, so the only narrowing left is its scopes, and the board
 * is resolved AT CALL TIME from `board.access[ctx.actor]` — the caller's live
 * membership. Lose access to a board and the very next call answers 403,
 * because the role lookup fails; no cached board list exists to go stale.
 */
import { ACTIONS, type Action, type CommandCtx } from '../commands/define.js';
import type { BoardWithId } from '../schema/board.js';
import type { Ticket } from '../schema/ticket.js';
import type { Tasklist } from '../schema/tasklist.js';
import { isAgentId, SCOPES, type BoardRole, type Scope } from '../types/index.js';

// The action vocabulary is a contract (commands/define.ts); re-exported here for can() callers.
export { ACTIONS, type Action };

/** What can() needs from the caller context — a CommandCtx satisfies it. */
export type CanCtx = Pick<CommandCtx, 'actor' | 'scopes' | 'boardIds' | 'ownerUid'>;
/** What can() reads from a board. */
export type CanBoard = Pick<BoardWithId, 'id' | 'access' | 'stageGrants'> & {
  settings: Pick<BoardWithId['settings'], 'allowDelete'>;
};
/** What can() reads from a ticket (only 'move' by a commenter needs it). */
export type CanTicket = Pick<Ticket, 'stageId' | 'assigneeUids'>;

/**
 * Which scopes let a token attempt each action (agents.html §E). A token needs
 * ANY of the listed scopes; routes and commands add their own finer gate
 * (REST_ROUTES / MCP_TOOLS / CommandSpec.scopes, patchScopes). An empty list
 * means no token may do it at all.
 *   - any scope implies reading the board it is used on
 *   - 'delete' (hard delete) is in no preset; a PERSON's token with tickets:state
 *     may (personMayHardDelete — the Claude app as the whole UI), an agent never
 *   - 'restore' is admin-only; tokens reach it with tickets:state
 */
export const ACTION_SCOPES: Record<Action, readonly Scope[]> = {
  read: SCOPES,
  comment: ['comments:write'],
  pin: ['comments:write'],
  create: ['tickets:create'],
  edit: ['tickets:update'],
  move: ['tickets:move'],
  assign: ['tickets:assign'],
  state: ['tickets:state'],
  restore: ['tickets:state'],
  delete: [],
  upload: ['files:write'],
  // §R1: an account token reaches board settings with boards:admin — still
  // only on boards where the person is an admin, because can() asks the role.
  admin: ['board:admin', 'webhooks:manage', 'boards:admin'],
  // phase 3 (§L)
  ask: ['questions:write'],
  answer: ['questions:write'],
  tasklist: ['tasklists:write'],
  status: ['status:write'],
};

/**
 * Hard delete through a token: a person who granted tickets:state (the Claude
 * app driving the whole UI) may, as in the app; an agent never may.
 */
function personMayHardDelete(ctx: CanCtx, action: Action): boolean {
  return action === 'delete' && !isAgentId(ctx.actor) && !!ctx.scopes?.includes('tickets:state');
}

export function scopeAllows(scopes: readonly Scope[], action: Action): boolean {
  return ACTION_SCOPES[action].some((s) => scopes.includes(s));
}

/** The actor's role on the board, or null when they are not on it. */
export function roleOf(board: Pick<BoardWithId, 'access'>, principalId: string): BoardRole | null {
  return Object.prototype.hasOwnProperty.call(board.access, principalId)
    ? (board.access[principalId] ?? null)
    : null;
}

/**
 * The role can() acts on. §AA2 CHANGED THIS: it used to read an agent's
 * 'admin' as 'editor' ("agents are never admin", agents.html §C). That rule
 * is gone — an agent may be a board admin — so this is now simply roleOf().
 * Kept as its own name because every caller means "the role that decides".
 */
export function effectiveRole(
  board: Pick<BoardWithId, 'access'>,
  principalId: string,
): BoardRole | null {
  return roleOf(board, principalId);
}

/**
 * §AA1 — AN AGENT REACHES A BOARD ONLY WHILE ITS OWNER IS ON IT.
 *
 * A board token acting as an agent always had this rule: the middleware
 * refused it once its owner left the board, and removing a person revoked
 * their tokens for it ("a token never outlives its creator's seat on the
 * board"). An agent token has no board to check in the middleware, so the
 * rule moves here, where every board is authorised anyway: when the request
 * says who answers for the agent (ctx.ownerUid — every token acting as an
 * agent carries it) and that person has no role on this board, the agent has
 * none either. Otherwise a person removed from a board would keep reading it
 * through an agent they had put there.
 *
 * A ctx without ownerUid (the UI asking "what could this agent do?", the
 * rules tests) is not narrowed: there is no request to narrow.
 */
function ownerSeated(ctx: CanCtx, board: Pick<BoardWithId, 'access'>): boolean {
  if (!isAgentId(ctx.actor) || !ctx.ownerUid || ctx.ownerUid === ctx.actor) return true;
  return roleOf(board, ctx.ownerUid) !== null;
}

const EDITOR_DENIED: ReadonlySet<Action> = new Set<Action>(['admin', 'restore']);
/**
 * What a commenter may do without a StageGrant check. Phase 3: asking and
 * answering a question is thread work, like commenting, and an agent that may
 * comment may also say what it is doing ('status').
 */
const COMMENTER_ALLOWED: ReadonlySet<Action> = new Set<Action>([
  'read',
  'comment',
  'upload',
  'ask',
  'answer',
  'status',
]);

/**
 * May `ctx.actor` (a person or an agent) do `action` on this board?
 * = the principal's role allows it (StageGrant for a commenter's move)
 *   ∩ the token's scopes (when there are any) ∩ the token's boardIds
 *   ∩ (an agent acting through a token) its owner still being on the board.
 */
export function can(
  ctx: CanCtx,
  board: CanBoard,
  action: Action,
  ticket?: CanTicket | null,
  toStageId?: string | null,
): boolean {
  const role = effectiveRole(board, ctx.actor);
  // Not on the board: nothing, not even read.
  if (!role) return false;
  // §AA1: nor when the agent's owner is no longer on it.
  if (!ownerSeated(ctx, board)) return false;

  if (ctx.scopes && !scopeAllows(ctx.scopes, action) && !personMayHardDelete(ctx, action))
    return false;
  if (ctx.boardIds && !ctx.boardIds.includes(board.id)) return false;

  // 'delete' additionally needs the board's hard-delete opt-in, whatever the role.
  if (action === 'delete' && !board.settings.allowDelete) return false;

  switch (role) {
    case 'admin':
      return true;
    case 'editor':
      return !EDITOR_DENIED.has(action);
    case 'commenter': {
      if (COMMENTER_ALLOWED.has(action)) return true;
      if (action !== 'move') return false;
      const grant = board.stageGrants[ctx.actor];
      if (!grant || !ticket || !toStageId) return false;
      if (!grant.stages.includes(ticket.stageId) || !grant.stages.includes(toStageId)) return false;
      return !grant.assignedOnly || ticket.assigneeUids.includes(ctx.actor);
    }
    case 'viewer':
      return action === 'read';
  }
}

/**
 * The actions a token's scopes could ever reach — for UIs that explain a
 * token ("this token can: read, comment, move"). Role still applies.
 */
export function actionsForScopes(scopes: readonly Scope[]): Action[] {
  return ACTIONS.filter((a) => scopeAllows(scopes, a));
}

/**
 * PHASE 3 — may this principal change a task list (§L2)?
 *
 * 'The owner (through its token) and editors can change a list. People may
 * also tick items by hand.' So: can(tasklist) — editor or admin — OR the
 * list's own owner, as long as they are at least a commenter on the board and
 * their token carries tasklists:write. A viewer never may.
 *
 * Pass `{ owner: ctx.actor }` for a list being CREATED: the creator owns it.
 */
export function canEditTasklist(
  ctx: CanCtx,
  board: CanBoard,
  list: Pick<Tasklist, 'owner'>,
): boolean {
  if (can(ctx, board, 'tasklist')) return true;
  if (list.owner !== ctx.actor) return false;
  if (effectiveRole(board, ctx.actor) !== 'commenter') return false;
  if (!ownerSeated(ctx, board)) return false;
  if (ctx.scopes && !scopeAllows(ctx.scopes, 'tasklist')) return false;
  if (ctx.boardIds && !ctx.boardIds.includes(board.id)) return false;
  return true;
}

/**
 * PHASE 3 — may this principal beat for `agentId` (§L3)? An agent's status is
 * its own: a token acting as the agent writes it, and so may a board admin
 * (the sweep and the owner's tooling). The scope is status:write.
 */
export function canHeartbeat(ctx: CanCtx, board: CanBoard, agentId: string): boolean {
  if (!can(ctx, board, 'status')) return false;
  return ctx.actor === agentId || effectiveRole(board, ctx.actor) === 'admin';
}
