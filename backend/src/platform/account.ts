/**
 * PHASE 17 (docs/plan/agents.html §Z2) — THE ACCOUNT-TOKEN ROUTES.
 *
 * `ws new` creates a workspace with the account token in workspaces/.env: it
 * creates the agent profile, the board from the kanban template, and puts
 * the agent on the board as an editor. Those three calls are the REST face of
 * agentCreate, boardCreate and boardAgentSet — THE SAME COMMANDS the app door
 * already exposes to a signed-in person. Nothing here is a new capability:
 * the commands decide (can(admin), the agent cap, the key claim), and their
 * scopes are ACCOUNT scopes (boards:create, agents:write, boards:admin), so a
 * board token is refused by the route gate before any of this runs.
 *
 * The one thing that stays with a person is the token itself (§R1): none of
 * these mint anything.
 */
import {
  errors,
  paths,
  type BoardWithId,
  type PublicAgent,
  type PublicBoard,
  type RestBoardAgentBody,
  type RestCreateAgentBody,
  type RestCreateBoardBody,
} from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { typedDoc } from '../runtime/converters.js';
import { getDoc } from '../runtime/tx.js';
import { loadBoard } from '../tickets/access.js';
import { invoke } from './ops.js';
import { boardMembers, toPublicAgent, toPublicBoard } from './public.js';
import { signedUrl } from './v1.js';

/** POST /v1/agents → agentCreate; answers the profile. */
export async function createAgent(
  ctx: ServerCtx,
  b: RestCreateAgentBody,
  key?: string,
): Promise<PublicAgent> {
  const res = await invoke(
    'agentCreate',
    {
      ...(b.id ? { agentId: b.id } : {}),
      name: b.name,
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.system_prompt !== undefined ? { systemPrompt: b.system_prompt } : {}),
      ...(b.avatar !== undefined ? { avatarPath: b.avatar } : {}),
      ...(b.icon !== undefined ? { icon: b.icon } : {}),
    },
    ctx,
    key ?? null,
  );
  const agent = await getDoc(typedDoc('agents', paths.agent(res.agentId)));
  if (!agent) throw errors.internal('The agent was created but cannot be read back');
  const avatar = agent.avatarPath ? (await signedUrl(agent.avatarPath, ctx.now)).url : null;
  return toPublicAgent(res.agentId, agent, avatar);
}

/** POST /v1/boards → boardCreate; answers the board as GET /v1/boards/{KEY} would. */
export async function createBoard(
  ctx: ServerCtx,
  b: RestCreateBoardBody,
  key?: string,
): Promise<PublicBoard> {
  const res = await invoke(
    'boardCreate',
    {
      name: b.name,
      key: b.key,
      ...(b.template ? { template: b.template } : {}),
      ...(b.color ? { color: b.color } : {}),
      ...(b.icon !== undefined ? { icon: b.icon } : {}),
      ...(b.indicator ? { indicator: b.indicator } : {}),
      ...(b.description != null ? { description: b.description } : {}),
    },
    ctx,
    key ?? null,
  );
  const board = await loadBoard(ctx, res.boardId);
  return toPublicBoard(board, await boardMembers(board.id));
}

/** POST /v1/boards/{KEY}/agents → boardAgentSet. */
export async function setBoardAgent(
  ctx: ServerCtx,
  board: BoardWithId,
  b: RestBoardAgentBody,
  key?: string,
): Promise<{ ok: true }> {
  await invoke(
    'boardAgentSet',
    {
      boardId: board.id,
      agentId: b.agent,
      role: b.role,
      ...(b.stage_grant !== undefined
        ? {
            stageGrant: b.stage_grant
              ? {
                  stages: b.stage_grant.stages,
                  ...(b.stage_grant.assigned_only !== undefined
                    ? { assignedOnly: b.stage_grant.assigned_only }
                    : {}),
                }
              : null,
          }
        : {}),
    },
    ctx,
    key ?? null,
  );
  return { ok: true };
}
