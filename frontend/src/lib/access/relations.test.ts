import { describe, expect, it } from 'vitest';
import {
  AGENT_ARTIFACT,
  AGENT_BOARD,
  ARTIFACT_BOARD,
  BOARD_MEMORY,
  can,
  normalize,
  toggle,
  WORKSPACE,
} from './relations';

describe('read / write relations', () => {
  it('maps boxes to the stored grant and back', () => {
    for (const r of [BOARD_MEMORY, ARTIFACT_BOARD]) {
      expect(r.fromPerms({ checks: [] })).toBeNull();
      expect(r.fromPerms({ checks: ['read'] })).toBe('read');
      expect(r.fromPerms({ checks: ['read', 'write'] })).toBe('write');
      // write alone still means write (it implies read)
      expect(r.fromPerms({ checks: ['write'] })).toBe('write');
      expect(r.toPerms('write').checks).toEqual(['read', 'write']);
      expect(r.toPerms('read').checks).toEqual(['read']);
      expect(r.toPerms(null).checks).toEqual([]);
      expect(r.chips(r.toPerms('write'))).toEqual(['Read', 'Write']);
    }
  });
  it('write ticks read; unticking read unticks write', () => {
    const p = BOARD_MEMORY.perms;
    expect(toggle(p, [], 'write', true)).toEqual(['read', 'write']);
    expect(toggle(p, ['read', 'write'], 'read', false)).toEqual([]);
    expect(toggle(p, ['read', 'write'], 'write', false)).toEqual(['read']);
  });
});

describe('agent on a board', () => {
  it('the highest ticked box is the role, and the boxes are cumulative', () => {
    const p = AGENT_BOARD.perms;
    expect(toggle(p, [], 'edit', true)).toEqual(['view', 'comment', 'edit']);
    expect(toggle(p, ['view', 'comment', 'edit', 'admin'], 'comment', false)).toEqual(['view']);
    expect(AGENT_BOARD.fromPerms({ checks: ['view', 'comment', 'edit'] })).toEqual({
      role: 'editor',
      stageGrant: null,
    });
    expect(AGENT_BOARD.fromPerms({ checks: [] })).toBeNull();
    expect(normalize(p, ['admin'])).toEqual(['view', 'comment', 'edit', 'admin']);
  });
  it('a commenter keeps its stage restriction; other roles drop it', () => {
    const g = { stages: ['s1'] };
    expect(AGENT_BOARD.fromPerms({ checks: ['view', 'comment'], stageGrant: g })).toEqual({
      role: 'commenter',
      stageGrant: g,
    });
    expect(AGENT_BOARD.fromPerms({ checks: ['view'], stageGrant: g })).toEqual({
      role: 'viewer',
      stageGrant: null,
    });
    const back = AGENT_BOARD.toPerms({ role: 'commenter', stageGrant: g });
    expect(back).toEqual({ checks: ['view', 'comment'], stageGrant: g });
    expect(AGENT_BOARD.chips(back, { stages: [{ id: 's1', name: 'Doing' } as never] })).toEqual([
      'Commenter',
      'Stages: Doing',
    ]);
  });
});

describe('agent on an artifact', () => {
  it('build and data are separate; write data implies read data', () => {
    expect(AGENT_ARTIFACT.fromPerms({ checks: ['build'] })).toEqual({ build: true, data: 'none' });
    expect(AGENT_ARTIFACT.fromPerms({ checks: ['write'] })).toEqual({
      build: false,
      data: 'write',
    });
    expect(AGENT_ARTIFACT.fromPerms({ checks: [] })).toBeNull();
    expect(AGENT_ARTIFACT.toPerms({ build: true, data: 'read' }).checks).toEqual(['build', 'read']);
    // the pre-§AA 'editor' reads as everything
    expect(AGENT_ARTIFACT.toPerms('editor' as never).checks).toEqual(['build', 'read', 'write']);
    expect(toggle(AGENT_ARTIFACT.perms, ['build', 'read', 'write'], 'read', false)).toEqual([
      'build',
    ]);
    expect(AGENT_ARTIFACT.chips({ checks: ['read', 'write'] })).toEqual([
      'Read data',
      'Write data',
    ]);
  });
});

describe('workspace and the rule mirror', () => {
  it('a workspace has no modes', () => {
    expect(WORKSPACE.perms).toEqual([]);
    expect(WORKSPACE.fromPerms({ checks: [] })).toBe(true);
  });
  it('either side may remove; only the owning side grants', () => {
    expect(can.revokeMemoryFromBoard({ ownsMemory: false, boardAdmin: true })).toBe(true);
    expect(can.revokeMemoryFromBoard({ ownsMemory: false, boardAdmin: false })).toMatch(/owner/);
    expect(can.grantMemoryToBoard({ ownsMemory: false, boardAdmin: true })).toMatch(/owner/);
    expect(can.revokeBoardFromArtifact({ ownsArtifact: false, boardAdmin: true })).toBe(true);
    expect(can.addAgentToBoard({ ownsAgent: true, boardAdmin: false })).toBe(
      'You are not an admin there',
    );
  });
});
