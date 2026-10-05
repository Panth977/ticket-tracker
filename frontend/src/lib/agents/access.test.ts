/**
 * §AA5 — the pure half of the agent page's Token and Access cards
 * (docs/plan/agents.html §AA1–§AA5).
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_BOARD_ROLES,
  AGENT_TOKEN_SCOPES,
  ARTIFACT_AGENT_FULL,
  COMMANDS,
  type ApiKey,
  type Artifact,
} from '@tm/shared';
import {
  AGENT_DATA_LABEL,
  AGENT_DATA_ORDER,
  AGENT_NEVER,
  AGENT_ROLE_HINT,
  AGENT_ROLE_LABEL,
  AGENT_ROLE_ORDER,
  agentAccessLabel,
  agentRoleOf,
  agentTokenName,
  agentTokenRequest,
  agentTokens,
  artifactAgentRemove,
  artifactAgentShare,
  artifactsOfAgent,
  artifactsToAddAgent,
  changeAccess,
  isAgentKey,
  NEW_AGENT_ACCESS,
  olderTokensLabel,
} from './access';

const AG = 'ag_AAAAAAAAAAAAAAAA';
const AG2 = 'ag_BBBBBBBBBBBBBBBB';
const NOW = 1_000_000;

type Key = Pick<
  ApiKey,
  'kind' | 'actsAs' | 'revokedAt' | 'expiresAt' | 'createdAt' | 'boardId' | 'defaultBoardId'
> & { id: string };
const key = (id: string, createdAt: number, o: Partial<Key> = {}): Key => ({
  id,
  kind: 'agent',
  actsAs: { kind: 'agent', id: AG },
  boardId: null,
  revokedAt: null,
  expiresAt: null,
  createdAt,
  ...o,
});

describe('board roles (§AA2)', () => {
  it('offers Viewer / Commenter / Editor / Admin, least to most', () => {
    expect([...AGENT_ROLE_ORDER]).toEqual(['viewer', 'commenter', 'editor', 'admin']);
    expect(AGENT_ROLE_ORDER.map((r) => AGENT_ROLE_LABEL[r])).toEqual([
      'Viewer',
      'Commenter',
      'Editor',
      'Admin',
    ]);
    // Every role the contract allows is in the menu — Admin included.
    expect([...AGENT_ROLE_ORDER].sort()).toEqual([...AGENT_BOARD_ROLES].sort());
  });

  it('describes each role in one line, from the §AA2 table', () => {
    for (const r of AGENT_ROLE_ORDER) {
      expect(AGENT_ROLE_HINT[r].length).toBeGreaterThan(10);
      expect(AGENT_ROLE_HINT[r]).not.toMatch(/\.$/); // callers finish the sentence
      expect(AGENT_ROLE_HINT[r]).not.toMatch(/\n/);
    }
    expect(AGENT_ROLE_HINT.viewer).toMatch(/^Read/);
    expect(AGENT_ROLE_HINT.commenter).toMatch(/comment/);
    expect(AGENT_ROLE_HINT.commenter).toMatch(/stage grant/);
    expect(AGENT_ROLE_HINT.editor).toMatch(/create, edit, move, assign, archive/);
    expect(AGENT_ROLE_HINT.admin).toMatch(/board settings, stages, fields, webhooks/);
    expect(AGENT_ROLE_HINT.admin).toMatch(/[Cc]omplete ownership/);
    // Nothing says an agent can never be admin any more; what stays with people is said once.
    for (const r of AGENT_ROLE_ORDER) expect(AGENT_ROLE_HINT[r]).not.toMatch(/never admin/i);
    expect(AGENT_NEVER).toMatch(/people/);
    expect(AGENT_NEVER).toMatch(/tokens/);
  });

  it('reads a stored role, and a stray value as viewer (never as more)', () => {
    expect(agentRoleOf('admin')).toBe('admin');
    expect(agentRoleOf('commenter')).toBe('commenter');
    expect(agentRoleOf('owner')).toBe('viewer');
    expect(agentRoleOf(undefined)).toBe('viewer');
  });
});

describe('the one token (§AA1, §AA5)', () => {
  it('no live token → nothing to show but Generate', () => {
    expect(agentTokens([], AG, NOW)).toEqual({ current: null, older: [], live: [] });
    const dead = [
      key('revoked', 5, { revokedAt: 6 }),
      key('expired', 4, { expiresAt: NOW - 1 }),
      key('someone-else', 9, { actsAs: { kind: 'agent', id: AG2 } }),
      key('me', 9, { kind: 'board', boardId: 'b1', actsAs: { kind: 'user', id: 'u1' } }),
    ];
    expect(agentTokens(dead, AG, NOW).current).toBe(null);
    expect(agentTokens(dead, AG, NOW).live).toEqual([]);
  });

  it('one live token → the token, no older ones', () => {
    const t = agentTokens([key('old', 1, { revokedAt: 2 }), key('k', 3)], AG, NOW);
    expect(t.current?.id).toBe('k');
    expect(t.older).toEqual([]);
    expect(t.live.map((k) => k.id)).toEqual(['k']);
  });

  it('several live tokens → the newest is the token, the rest are "older", newest first', () => {
    const keys = [
      // Converted by the migration (§AA6): kind 'agent', its old board kept as the default.
      key('conv-eng', 10, { defaultBoardId: 'b_eng' }),
      key('conv-ops', 20, { defaultBoardId: 'b_ops' }),
      // Not converted yet: a legacy board token acting as this agent still counts.
      key('legacy', 15, { kind: 'board', boardId: 'b_mkt' }),
      // The one issued by the migration / generated since.
      key('new', 30),
      key('gone', 40, { revokedAt: 41, revokedReason: 'rotated' } as Partial<Key>),
    ];
    const t = agentTokens(keys, AG, NOW);
    expect(t.current?.id).toBe('new');
    expect(t.older.map((k) => k.id)).toEqual(['conv-ops', 'legacy', 'conv-eng']);
    expect(t.live.map((k) => k.id)).toEqual(['new', 'conv-ops', 'legacy', 'conv-eng']);
    // "Revoke older tokens" revokes exactly these — never the newest.
    expect(t.older).not.toContain(t.current);
    expect(t.older.find((k) => k.id === 'conv-eng')?.defaultBoardId).toBe('b_eng');
  });

  it('an expiry in the future is still live', () => {
    expect(agentTokens([key('k', 1, { expiresAt: NOW + 1 })], AG, NOW).current?.id).toBe('k');
  });

  it('says how many older tokens still work', () => {
    expect(olderTokensLabel(0)).toBe('');
    expect(olderTokensLabel(1)).toBe('1 older token still works');
    expect(olderTokensLabel(2)).toBe('2 older tokens still work');
  });

  it('knows which keys carry an agent’s identity', () => {
    expect(isAgentKey(key('a', 1))).toBe(true);
    expect(isAgentKey(key('b', 1, { kind: 'board', boardId: 'b1' }))).toBe(true);
    expect(isAgentKey({ actsAs: { kind: 'user', id: 'u1' } })).toBe(false);
  });

  it('builds apiKeyCreate for kind agent: who the agent is, and nothing else', () => {
    const req = agentTokenRequest(AG, '  Builder ');
    expect(req).toEqual({ kind: 'agent', actsAs: { kind: 'agent', id: AG }, name: 'Builder' });
    // No board, no scopes, and never keepOthers: the new token REPLACES the others.
    expect(req).not.toHaveProperty('boardId');
    expect(req).not.toHaveProperty('scopes');
    expect(req).not.toHaveProperty('keepOthers');
    // … and the landed contract accepts exactly this.
    const parsed = COMMANDS.apiKeyCreate.req.safeParse(req);
    expect(parsed.success).toBe(true);
    expect(AGENT_TOKEN_SCOPES.length).toBeGreaterThan(0);
  });

  it('names the token after the agent, within apiKeyCreate’s 80 characters', () => {
    expect(agentTokenName('Builder')).toBe('Builder');
    expect(agentTokenName('   ')).toBe('agent');
    expect(agentTokenName('x'.repeat(200))).toHaveLength(80);
  });
});

const art = (
  id: string,
  name: string,
  o: Partial<Pick<Artifact, 'agents' | 'ownerUid' | 'archivedAt'>> = {},
) => ({ id, name, ownerUid: 'me', archivedAt: null, agents: {}, ...o });

describe('artifacts: build and data, separately (§AA3)', () => {
  it('offers None / Read / Read & write', () => {
    expect(AGENT_DATA_ORDER.map((d) => AGENT_DATA_LABEL[d])).toEqual([
      'None',
      'Read',
      'Read & write',
    ]);
  });

  it('lists the artifacts an agent is on, normalising the legacy value', () => {
    const list = [
      art('a3', 'Zeta', { agents: { [AG]: { build: false, data: 'read' } } }),
      // Pre-§AA rows said 'editor': that reads as Build + Read & write.
      art('a1', 'Alpha', { agents: { [AG]: 'editor' } }),
      art('a2', 'Beta', { agents: { [AG2]: 'editor' } }),
      art('a4', 'Old', { agents: { [AG]: 'editor' }, archivedAt: 5 }),
      // A stored "nothing" is not on it.
      art('a5', 'Empty', { agents: { [AG]: { build: false, data: 'none' } } }),
    ];
    expect(artifactsOfAgent(list, AG).map((r) => [r.artifact.id, r.access])).toEqual([
      ['a1', { build: true, data: 'write' }],
      ['a3', { build: false, data: 'read' }],
    ]);
  });

  it('offers only artifacts I OWN that it is not on yet', () => {
    const list = [
      art('a1', 'Mine, on it', { agents: { [AG]: 'editor' } }),
      art('a2', 'Mine, free'),
      art('a3', 'Someone else’s', { ownerUid: 'other' }),
      art('a4', 'Mine, archived', { archivedAt: 1 }),
      art('a0', 'A mine, other agent', { agents: { [AG2]: { build: true, data: 'none' } } }),
    ];
    expect(artifactsToAddAgent(list, 'me', AG).map((a) => a.id)).toEqual(['a0', 'a2']);
  });

  it('a control change becomes the next { build, data }', () => {
    const cur = { build: true, data: 'write' } as const;
    expect(changeAccess(cur, { data: 'read' })).toEqual({
      next: { build: true, data: 'read' },
      same: false,
      removes: false,
    });
    expect(changeAccess(cur, { build: false })).toEqual({
      next: { build: false, data: 'write' },
      same: false,
      removes: false,
    });
    // Nothing changed → nothing to send.
    expect(changeAccess(cur, { build: true }).same).toBe(true);
    expect(changeAccess(cur, {}).same).toBe(true);
  });

  it('turning off the LAST permission is a removal — flagged, so the screen asks first', () => {
    const buildOnly = changeAccess({ build: true, data: 'none' }, { build: false });
    expect(buildOnly.removes).toBe(true);
    expect(buildOnly.next).toEqual({ build: false, data: 'none' });
    const dataOnly = changeAccess({ build: false, data: 'read' }, { data: 'none' });
    expect(dataOnly.removes).toBe(true);
    // Not the last one: no question.
    expect(changeAccess({ build: true, data: 'read' }, { data: 'none' }).removes).toBe(false);
    expect(changeAccess({ build: true, data: 'read' }, { build: false }).removes).toBe(false);
    // Already nothing and still nothing is not a removal either.
    expect(changeAccess({ build: false, data: 'none' }, { build: false }).removes).toBe(false);
  });

  it('changes a legacy row from what it MEANT', () => {
    // 'editor' = Build + Read & write; unticking Build leaves the data.
    expect(changeAccess('editor', { build: false })).toEqual({
      next: { build: false, data: 'write' },
      same: false,
      removes: false,
    });
    expect(changeAccess('editor', { build: true, data: 'write' }).same).toBe(true);
    // A stray value is "nothing", never more.
    expect(changeAccess('owner', { data: 'read' }).next).toEqual({ build: false, data: 'read' });
  });

  it('builds artifactShare with agentAccess — the object form, never the old role', () => {
    const input = artifactAgentShare('art_000001', AG, { build: true, data: 'read' });
    expect(input).toEqual({
      artifactId: 'art_000001',
      agentId: AG,
      agentAccess: { build: true, data: 'read' },
    });
    expect(input).not.toHaveProperty('role');
    // The landed contract accepts it, and the removal form too.
    expect(COMMANDS.artifactShare.req.safeParse(input).success).toBe(true);
    expect(
      COMMANDS.artifactShare.req.safeParse(artifactAgentRemove('art_000001', AG)).success,
    ).toBe(true);
    expect(artifactAgentRemove('art_000001', AG).agentAccess).toEqual({
      build: false,
      data: 'none',
    });
    // A frozen constant goes in, a plain object comes out (it is sent as JSON).
    expect(artifactAgentShare('art_000001', AG, ARTIFACT_AGENT_FULL).agentAccess).not.toBe(
      ARTIFACT_AGENT_FULL,
    );
  });

  it('starts a new agent from what "editor" meant, and labels a row', () => {
    expect(NEW_AGENT_ACCESS).toEqual({ build: true, data: 'write' });
    expect(agentAccessLabel('editor')).toBe('Build · Data: read & write');
    expect(agentAccessLabel({ build: false, data: 'read' })).toBe('Data: read');
    expect(agentAccessLabel({ build: true, data: 'none' })).toBe('Build');
    expect(agentAccessLabel(undefined)).toBe('No access');
  });
});
