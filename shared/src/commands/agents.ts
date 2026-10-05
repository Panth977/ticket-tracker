/**
 * Phase 2 — agent profiles, agents on boards, the agent inbox
 * (docs/plan/agents.html §B, §C, §D). App-only: no token scope reaches these,
 * except agentInboxAck, which the REST / MCP doors call for an agent token.
 */
import { z } from 'zod';
import { AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX, AGENT_SYSTEM_PROMPT_MAX } from '../schema/agent.js';
import { AgentBoardRoleSchema } from '../schema/board.js';
import {
  AgentIconIdSchema,
  AgentIdSchema,
  BoardIdSchema,
  StageGrantSchema,
  StoragePathSchema,
} from '../types/index.js';
import { defineCommand, OkResSchema, req } from './define.js';

const AgentName = z.string().trim().min(1).max(AGENT_NAME_MAX);
const AgentDescription = z.string().trim().max(AGENT_DESCRIPTION_MAX);
const SystemPrompt = z.string().max(AGENT_SYSTEM_PROMPT_MAX);

export const agentCreate = defineCommand({
  name: 'agentCreate',
  source: 'phase2',
  /** §R1: account tokens only (agents:write) — an agent profile is account-level, not board-level. */
  scopes: ['agents:write'],
  permission: 'Any signed-in person; they become its owner. 50 agents per person.',
  errors: ['invalid', 'conflict', 'rate_limited'],
  req: req({
    /**
     * Optional client-generated id ('ag_' + 16), so the avatar can be uploaded
     * to users/{uid}/agents/{agentId}/avatar/… before the profile exists. A
     * taken id → 409.
     */
    agentId: AgentIdSchema.optional(),
    name: AgentName,
    description: AgentDescription.nullable().optional(),
    systemPrompt: SystemPrompt.optional(),
    /** Must be under storage.agentAvatarPrefix(actor, agentId). */
    avatarPath: StoragePathSchema.nullable().optional(),
    /** A prebuilt icon id (AGENT_ICON_IDS); shown when there is no picture. */
    icon: AgentIconIdSchema.nullable().optional(),
  }),
  res: z.object({ agentId: AgentIdSchema }),
});

export const agentUpdate = defineCommand({
  name: 'agentUpdate',
  source: 'phase2',
  /** §R1: account tokens only (agents:write) — an agent profile is account-level, not board-level. */
  scopes: ['agents:write'],
  permission:
    'Owner only (404 otherwise — agents are private). Not archived (409). name / avatarPath / icon / description are copied to members/{agentId} on every board it is on.',
  errors: ['not_found', 'conflict', 'invalid'],
  req: req({
    agentId: AgentIdSchema,
    name: AgentName.optional(),
    description: AgentDescription.nullable().optional(),
    systemPrompt: SystemPrompt.optional(),
    avatarPath: StoragePathSchema.nullable().optional(),
    /** A prebuilt icon id (AGENT_ICON_IDS); null clears it. The picture, if any, stays. */
    icon: AgentIconIdSchema.nullable().optional(),
  }),
  res: OkResSchema,
});

export const agentArchive = defineCommand({
  name: 'agentArchive',
  source: 'phase2',
  /** §R1: account tokens only (agents:write) — an agent profile is account-level, not board-level. */
  scopes: ['agents:write'],
  permission:
    "Owner only. archive: takes it off every board (like boardAgentSet role:null) and revokes every token acting as it (revokedReason 'agentArchived'). restore: clears archivedAt; it rejoins no board and no token comes back.",
  errors: ['not_found'],
  req: req({ agentId: AgentIdSchema, action: z.enum(['archive', 'restore']).default('archive') }),
  res: z.object({
    ok: z.literal(true),
    /** archive: boards it was removed from, tokens revoked. */
    boardsLeft: z.number().int().nonnegative(),
    tokensRevoked: z.number().int().nonnegative(),
  }),
});

export const boardAgentSet = defineCommand({
  name: 'boardAgentSet',
  source: 'phase2',
  /** §R1: account tokens only. The handler still needs can(admin), i.e. boards:admin. */
  scopes: ['agents:write', 'boards:admin'],
  permission:
    "A PERSON only — an agent never manages a board's agents, whatever its role (§AA2). Adding (the agent not on the board yet): a board admin who OWNS the agent, agent not archived. Changing role / stageGrant or removing: any board admin. §AA2: the role may be 'admin'. Removing works like removing a person (off assignees and watchers, messages stay) and revokes its LEGACY board tokens for this board (revokedReason 'agentRemoved') — never its agent token (§AA1), which simply stops reaching this board.",
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({
    boardId: BoardIdSchema,
    agentId: AgentIdSchema,
    /** null removes the agent from the board. */
    role: AgentBoardRoleSchema.nullable(),
    /** Commenters only; null clears it. Absent = unchanged (or none, when adding). */
    stageGrant: StageGrantSchema.nullable().optional(),
  }),
  res: OkResSchema,
});

export const MAX_ACK_IDS = 500;

export const agentInboxAck = defineCommand({
  name: 'agentInboxAck',
  source: 'phase2',
  scopes: ['events:read'],
  permission:
    "The agent's owner (app), or a token acting as that agent (REST POST /v1/events/ack, MCP ack_events). Sets ackedAt on the named events, or on every event with id ≤ upTo. Acking twice is ok.",
  errors: ['forbidden', 'not_found', 'invalid'],
  req: req({
    agentId: AgentIdSchema,
    ids: z.array(z.string().min(1).max(128)).min(1).max(MAX_ACK_IDS).optional(),
    /** A feed cursor / event id: ack everything up to and including it. */
    upTo: z.string().min(1).max(128).optional(),
  }).refine((r) => (r.ids === undefined) !== (r.upTo === undefined), {
    message: 'Exactly one of ids or upTo',
  }),
  res: z.object({ ok: z.literal(true), acked: z.number().int().nonnegative() }),
});
