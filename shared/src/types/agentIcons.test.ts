import { describe, expect, it } from 'vitest';
import {
  AGENT_BRAND_ICONS,
  AGENT_GENERIC_ICONS,
  AGENT_ICON_ID_MAX,
  AGENT_ICON_IDS,
  AGENT_ICONS,
  AgentIconIdSchema,
  isAgentIconId,
} from './agentIcons.js';
import { AgentSchema } from '../schema/agent.js';
import { BoardMemberSchema } from '../schema/board.js';
import { agentCreate, agentUpdate } from '../commands/agents.js';
import { RestCreateAgentBodySchema } from '../api/rest.js';
import { agentMemberFixture, fixtures } from '../schema/fixtures.js';

describe('agent icons (agents.html §B)', () => {
  it('ids are unique, short, lowercase and kinded', () => {
    expect(new Set(AGENT_ICON_IDS).size).toBe(AGENT_ICONS.length);
    for (const i of AGENT_ICONS) {
      expect(i.id.length).toBeLessThanOrEqual(AGENT_ICON_ID_MAX);
      expect(i.id).toMatch(/^[a-z0-9-]+$/);
      expect(i.label.length).toBeGreaterThan(0);
      expect(['brand', 'generic']).toContain(i.kind);
    }
    expect(AGENT_BRAND_ICONS.map((i) => i.id)).toEqual([
      'claude',
      'gemini',
      'chatgpt',
      'copilot',
      'mistral',
      'llama',
      'cursor',
    ]);
    expect(AGENT_GENERIC_ICONS.length + AGENT_BRAND_ICONS.length).toBe(AGENT_ICONS.length);
    expect(AGENT_GENERIC_ICONS.map((i) => i.id)).toContain('bot');
  });

  it('the schema takes a known id and refuses anything else', () => {
    expect(AgentIconIdSchema.safeParse('claude').success).toBe(true);
    expect(AgentIconIdSchema.safeParse('bot').success).toBe(true);
    expect(AgentIconIdSchema.safeParse('Claude').success).toBe(false);
    expect(AgentIconIdSchema.safeParse('nope').success).toBe(false);
    expect(AgentIconIdSchema.safeParse('').success).toBe(false);
    expect(AgentIconIdSchema.safeParse(3).success).toBe(false);
    expect(isAgentIconId('gemini')).toBe(true);
    expect(isAgentIconId('x'.repeat(41))).toBe(false);
    expect(isAgentIconId(null)).toBe(false);
  });

  it('agents/{id} and members/{id} carry it, nullable and optional', () => {
    expect(AgentSchema.safeParse(fixtures.agents).success).toBe(true);
    expect(AgentSchema.safeParse({ ...fixtures.agents, icon: 'rocket' }).success).toBe(true);
    expect(AgentSchema.safeParse({ ...fixtures.agents, icon: null }).success).toBe(true);
    expect(AgentSchema.safeParse({ ...fixtures.agents, icon: 'unicorn' }).success).toBe(false);
    expect(BoardMemberSchema.safeParse({ ...agentMemberFixture, icon: 'claude' }).success).toBe(
      true,
    );
    expect(BoardMemberSchema.safeParse({ ...agentMemberFixture, icon: 'unicorn' }).success).toBe(
      false,
    );
  });

  it('agentCreate / agentUpdate / POST /v1/agents accept icon (null clears)', () => {
    expect(agentCreate.req.safeParse({ name: 'Builder', icon: 'claude' }).success).toBe(true);
    expect(agentCreate.req.safeParse({ name: 'Builder', icon: null }).success).toBe(true);
    expect(agentCreate.req.safeParse({ name: 'Builder', icon: 'unicorn' }).success).toBe(false);
    const id = 'ag_Bu1lder000000001';
    expect(agentUpdate.req.safeParse({ agentId: id, icon: 'terminal' }).success).toBe(true);
    expect(agentUpdate.req.safeParse({ agentId: id, icon: null }).success).toBe(true);
    expect(agentUpdate.req.safeParse({ agentId: id, icon: 'Terminal' }).success).toBe(false);
    expect(RestCreateAgentBodySchema.safeParse({ name: 'Builder', icon: 'gemini' }).success).toBe(
      true,
    );
    expect(RestCreateAgentBodySchema.safeParse({ name: 'Builder', icon: 'x' }).success).toBe(false);
  });
});
