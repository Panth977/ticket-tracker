/** Phase 2 contracts: principals, agent members, agents, the agent inbox, API keys v2, scope vocabulary. */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SCOPES,
  ARTIFACT_SCOPES,
  MEMORY_SCOPES,
  ADMIN_SCOPES,
  AGENT_TOKEN_SCOPES,
  AgentIdSchema,
  isAgentTokenScopes,
  isAccountScope,
  isAgentId,
  LEGACY_SCOPES,
  newAgentId,
  normalizeScopes,
  principalKind,
  PrincipalRefSchema,
  ScopeListInputSchema,
  SCOPE_PRESETS,
  SCOPES,
  TOKEN_SCOPES,
} from '../types/index.js';
import { agentEventId, agentEventTime, AgentInboxEventSchema, AgentSchema } from './agent.js';
import { ApiKeySchema, apiKeyActive, apiKeyKind, OAuthGrantSchema } from './user.js';
import { AGENT_BOARD_ROLES, BoardMemberSchema, BoardSchema } from './board.js';
import { MessageSchema, TicketSchema } from './ticket.js';
import { OAuthTokenSchema } from './platform.js';
import { agentMemberFixture, AGENT_ID, fixtures } from './fixtures.js';

describe('principals', () => {
  it('agent ids', () => {
    expect(isAgentId(AGENT_ID)).toBe(true);
    expect(isAgentId('uid_asha')).toBe(false);
    expect(isAgentId('ag_short')).toBe(false);
    expect(isAgentId(null)).toBe(false);
    expect(principalKind(AGENT_ID)).toBe('agent');
    expect(principalKind('uid_asha')).toBe('user');
    const id = newAgentId();
    expect(AgentIdSchema.safeParse(id).success).toBe(true);
    expect(newAgentId(() => 0)).toBe('ag_AAAAAAAAAAAAAAAA');
  });
  it('PrincipalRef', () => {
    expect(PrincipalRefSchema.safeParse({ kind: 'agent', id: AGENT_ID }).success).toBe(true);
    expect(PrincipalRefSchema.safeParse({ kind: 'agent', id: 'uid_asha' }).success).toBe(false);
    expect(PrincipalRefSchema.safeParse({ kind: 'user', id: 'uid_asha' }).success).toBe(true);
  });
  it('people fields hold agents too', () => {
    const t = TicketSchema.parse({
      ...fixtures.tickets,
      assigneeUids: [AGENT_ID],
      watcherUids: ['uid_asha', AGENT_ID],
      createdBy: AGENT_ID,
    });
    expect(t.assigneeUids).toEqual([AGENT_ID]);
    const m = MessageSchema.parse({
      ...fixtures.messages,
      authorUid: AGENT_ID,
      via: 'mcp',
      viaToken: 'orch-eng-builder',
      markdown: '| a |\n|---|\n| 1 |',
    });
    expect(m.viaToken).toBe('orch-eng-builder');
  });
});

describe('board members: people and agents', () => {
  it('phase-1 docs (no kind) parse as users', () => {
    const { kind: _k, ...old } = fixtures.members;
    expect(BoardMemberSchema.parse(old).kind).toBe('user');
  });
  it('an agent row parses', () => {
    expect(BoardMemberSchema.safeParse(agentMemberFixture).success).toBe(true);
  });
  // §AA2 changed the first assertion: an agent member MAY be admin now.
  it('§AA2: agents may be admin; they carry owner + addedBy, and use ag_ ids', () => {
    expect(BoardMemberSchema.safeParse({ ...agentMemberFixture, role: 'admin' }).success).toBe(
      true,
    );
    expect(
      BoardMemberSchema.safeParse({ ...agentMemberFixture, ownerUid: undefined }).success,
    ).toBe(false);
    expect(BoardMemberSchema.safeParse({ ...agentMemberFixture, addedBy: undefined }).success).toBe(
      false,
    );
    expect(BoardMemberSchema.safeParse({ ...agentMemberFixture, uid: 'uid_x' }).success).toBe(
      false,
    );
    expect(BoardMemberSchema.safeParse({ ...fixtures.members, uid: AGENT_ID }).success).toBe(false);
  });
});

describe('agents and the agent inbox', () => {
  it('profile limits', () => {
    expect(
      AgentSchema.safeParse({ ...fixtures.agents, systemPrompt: 'x'.repeat(50_000) }).success,
    ).toBe(true);
    expect(
      AgentSchema.safeParse({ ...fixtures.agents, systemPrompt: 'x'.repeat(50_001) }).success,
    ).toBe(false);
    expect(AgentSchema.safeParse({ ...fixtures.agents, name: 'x'.repeat(61) }).success).toBe(false);
  });
  it('inbox events', () => {
    expect(
      AgentInboxEventSchema.safeParse({ ...fixtures.agentInbox, type: 'unassigned' }).success,
    ).toBe(true);
    expect(
      AgentInboxEventSchema.safeParse({ ...fixtures.agentInbox, type: 'dueSoon' }).success,
    ).toBe(false);
  });
  it('event ids sort by time and decode', () => {
    const a = agentEventId(1_758_531_600_000, 'x1');
    const b = agentEventId(1_758_531_600_001, 'a0');
    expect(a < b).toBe(true);
    expect(agentEventTime(a)).toBe(1_758_531_600_000);
    expect(agentEventTime('garbage')).toBeNull();
    expect(() => agentEventId(1, 'a/b')).toThrow();
  });
});

describe('§AA boards: agent roles and agentIds', () => {
  it("AGENT_BOARD_ROLES gained 'admin'", () => {
    expect([...AGENT_BOARD_ROLES]).toEqual(['admin', 'editor', 'commenter', 'viewer']);
  });
  it('a board parses with and without agentIds (absent until the migration backfills it)', () => {
    const b = fixtures.boards;
    expect(BoardSchema.safeParse(b).success).toBe(true);
    expect(BoardSchema.safeParse({ ...b, agentIds: [AGENT_ID] }).success).toBe(true);
    // a person's uid is not an agent id
    expect(BoardSchema.safeParse({ ...b, agentIds: ['uid_asha'] }).success).toBe(false);
  });
});

describe('API keys v2', () => {
  it('one board, actsAs, new scopes only', () => {
    const k = fixtures.apiKeys;
    expect(ApiKeySchema.safeParse(k).success).toBe(true);
    expect(ApiKeySchema.safeParse({ ...k, actsAs: { kind: 'user', id: 'uid_asha' } }).success).toBe(
      true,
    );
    expect(ApiKeySchema.safeParse({ ...k, scopes: ['tickets:write'] }).success).toBe(false);
    expect(ApiKeySchema.safeParse({ ...k, boardId: undefined, boardIds: ['b'] }).success).toBe(
      false,
    );
  });
  // §AA narrowed this rule to LEGACY rows: kind 'board' acting as an agent.
  // A kind 'agent' token always carries the admin scopes (next describe).
  it('a BOARD token acting as an agent never carries admin scopes', () => {
    expect(ApiKeySchema.safeParse({ ...fixtures.apiKeys, scopes: ['board:admin'] }).success).toBe(
      false,
    );
    expect(
      ApiKeySchema.safeParse({
        ...fixtures.apiKeys,
        actsAs: { kind: 'user', id: 'uid_asha' },
        scopes: ['board:admin'],
      }).success,
    ).toBe(true);
  });
  it("§AA1 kind 'agent': acts as an agent, no board, exactly AGENT_TOKEN_SCOPES", () => {
    const k = {
      ...fixtures.apiKeys,
      kind: 'agent',
      boardId: null,
      actsAs: { kind: 'agent', id: AGENT_ID },
      scopes: [...AGENT_TOKEN_SCOPES],
    };
    expect(ApiKeySchema.safeParse(k).success).toBe(true);
    expect(apiKeyKind(ApiKeySchema.parse(k))).toBe('agent');
    // order does not matter, the set does
    expect(
      ApiKeySchema.safeParse({ ...k, scopes: [...AGENT_TOKEN_SCOPES].reverse() }).success,
    ).toBe(true);
    // converted from a board token (§AA6): its old board rides along
    expect(ApiKeySchema.safeParse({ ...k, defaultBoardId: 'board_eng' }).success).toBe(true);
    expect(ApiKeySchema.safeParse({ ...k, defaultBoardId: null }).success).toBe(true);
    expect(ApiKeySchema.safeParse({ ...k, revokedAt: 5, revokedReason: 'rotated' }).success).toBe(
      true,
    );
    // never a board, never a person, never a narrower or wider scope list
    expect(ApiKeySchema.safeParse({ ...k, boardId: 'board_eng' }).success).toBe(false);
    expect(ApiKeySchema.safeParse({ ...k, actsAs: { kind: 'user', id: 'uid_asha' } }).success).toBe(
      false,
    );
    expect(ApiKeySchema.safeParse({ ...k, scopes: ['board:read'] }).success).toBe(false);
    expect(
      ApiKeySchema.safeParse({ ...k, scopes: [...AGENT_TOKEN_SCOPES, 'boards:create'] }).success,
    ).toBe(false);
    // defaultBoardId belongs to agent tokens only
    expect(
      ApiKeySchema.safeParse({ ...fixtures.apiKeys, defaultBoardId: 'board_eng' }).success,
    ).toBe(false);
  });
  it('§AA1 AGENT_TOKEN_SCOPES = every board scope + the 2 admin + the 2 artifact + the 2 memory scopes, no account scope', () => {
    expect([...AGENT_TOKEN_SCOPES]).toEqual([
      ...TOKEN_SCOPES,
      ...ADMIN_SCOPES,
      ...ARTIFACT_SCOPES,
      ...MEMORY_SCOPES,
    ]);
    expect(AGENT_TOKEN_SCOPES.some(isAccountScope)).toBe(false);
    expect(isAgentTokenScopes([...AGENT_TOKEN_SCOPES])).toBe(true);
    expect(isAgentTokenScopes([...TOKEN_SCOPES])).toBe(false);
  });
  it('§AA6: rows written before §AA still parse — no kind, or kind board, acting as an agent', () => {
    const { kind: _k, ...old } = fixtures.apiKeys as Record<string, unknown>;
    expect(ApiKeySchema.safeParse(old).success).toBe(true);
    expect(apiKeyKind(old)).toBe('board');
    expect(ApiKeySchema.safeParse({ ...old, kind: 'board' }).success).toBe(true);
    expect(
      ApiKeySchema.safeParse({ ...old, revokedAt: 5, revokedReason: 'agentRemoved' }).success,
    ).toBe(true);
  });
  it('apiKeyActive', () => {
    const k = { revokedAt: null, expiresAt: null };
    expect(apiKeyActive(k, 5)).toBe(true);
    expect(apiKeyActive({ ...k, expiresAt: 5 }, 5)).toBe(false);
    expect(apiKeyActive({ ...k, revokedAt: 1 }, 5)).toBe(false);
  });
});

describe('scope vocabulary', () => {
  it('16 token scopes in form order + 2 admin + 4 account + 2 artifact + 2 memory (13 phase 2, 3 phase 3, 4 phase 10)', () => {
    expect(TOKEN_SCOPES).toHaveLength(16);
    expect(ADMIN_SCOPES).toHaveLength(2);
    // §R1 added the account scopes; they live at the END so the form's
    // checkbox order (TOKEN_SCOPES) is untouched.
    expect(ACCOUNT_SCOPES).toHaveLength(4);
    expect(SCOPES).toHaveLength(26);
    expect(SCOPES.slice(0, 16)).toEqual([...TOKEN_SCOPES]);
    expect(SCOPE_PRESETS.everything).toEqual([...TOKEN_SCOPES]);
    // Every preset draws only on the vocabulary; only 'fullAccount' (an
    // account token's preset) may reach past the board checkboxes.
    for (const [name, preset] of Object.entries(SCOPE_PRESETS))
      for (const s of preset) {
        expect(SCOPES).toContain(s);
        if (name !== 'fullAccount') expect(TOKEN_SCOPES).toContain(s);
      }
    expect(SCOPE_PRESETS.fullAccount).toEqual([
      ...TOKEN_SCOPES,
      ...ACCOUNT_SCOPES,
      ...ARTIFACT_SCOPES,
      ...MEMORY_SCOPES,
    ]);
    for (const s of ACCOUNT_SCOPES) expect(isAccountScope(s)).toBe(true);
    for (const s of TOKEN_SCOPES) expect(isAccountScope(s)).toBe(false);
  });
  it('phase-1 scopes expand; unknown ones are reported', () => {
    for (const s of LEGACY_SCOPES) expect(normalizeScopes([s]).scopes.length).toBeGreaterThan(0);
    expect(normalizeScopes(['tickets:write']).scopes).toContain('tickets:move');
    expect(normalizeScopes(['boards:write']).scopes).toContain('board:admin');
    expect(normalizeScopes(['tickets:move', 'nope']).unknown).toEqual(['nope']);
    expect(normalizeScopes(['events:read', 'events:read']).scopes).toEqual(['events:read']);
  });
  it('OAuth grants / tokens read phase-1 names as the new vocabulary', () => {
    const g = OAuthGrantSchema.parse({
      ...fixtures.oauthGrants,
      scopes: ['tickets:read', 'comments:write'],
    });
    expect(g.scopes).toEqual(
      expect.arrayContaining(['board:read', 'tickets:read', 'comments:write', 'files:write']),
    );
    expect(OAuthTokenSchema.safeParse({ ...fixtures.oauthTokens, scopes: ['bogus'] }).success).toBe(
      false,
    );
    expect(ScopeListInputSchema.parse(['board:read'])).toEqual(['board:read']);
  });
});
