/**
 * scripts/lib/indicators.mjs — the pure planning half of the indicators
 * migration (the emulator half is rules/migrate-indicators.test.ts).
 */
import { describe, expect, it } from 'vitest';
import * as S from '@tm/shared';
import {
  planArtifact,
  planBoard,
  planMemory,
  planStages,
  planWorkspace,
} from '../../scripts/lib/indicators.mjs';

const stage = (id: string, color: string, extra: object = {}) => ({
  id,
  name: id,
  color,
  category: 'todo',
  position: 0,
  ...extra,
});
const richText = (text: string) => ({
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  text,
  mentions: [],
  refs: [],
});

describe('planBoard', () => {
  it('legacy colour name + typed lucide icon → an icon indicator in hex', () => {
    const p = planBoard(S, {
      id: 'b1',
      color: 'blue',
      icon: 'rocket',
      description: null,
      stages: [stage('s1', 'slate')],
    });
    expect(p?.indicator).toEqual({ kind: 'icon', icon: 'rocket', color: '#3b82f6' });
    expect(p?.color).toBeUndefined(); // a usable legacy colour is kept
    expect(p?.stages[0].indicator).toEqual({ kind: 'color', color: '#64748b' });
    expect(p?.stages[0].description).toBeUndefined();
    expect('description' in p!).toBe(false);
  });

  it('an emoji icon → emoji; an unknown colour gets the indicator colour', () => {
    const p = planBoard(S, { id: 'b2', color: 'ultraviolet', icon: '🚀', description: null });
    expect(p?.indicator).toEqual({ kind: 'emoji', emoji: '🚀' });
    expect(p?.color).toBe(S.INDICATOR_COLORS[0]);
  });

  it('a typed non-icon string → a colour indicator', () => {
    const p = planBoard(S, { id: 'b3', color: '#22C55E', icon: 'KB', description: null });
    expect(p?.indicator).toEqual({ kind: 'color', color: '#22c55e' });
  });

  it('rich-text description → plain text; an empty one → null', () => {
    expect(
      planBoard(S, {
        id: 'b',
        indicator: { kind: 'color', color: '#6366f1' },
        description: {
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Ship ' },
                  { type: 'text', text: 'it', marks: [{ type: 'bold' }] },
                ],
              },
            ],
          },
          text: 'Ship it',
          mentions: [],
          refs: [],
        },
      }),
    ).toEqual({
      description: 'Ship **it**',
    });
    expect(
      planBoard(S, {
        id: 'b',
        indicator: { kind: 'color', color: '#6366f1' },
        description: { doc: { type: 'doc', content: [] }, text: '', mentions: [], refs: [] },
      }),
    ).toEqual({ description: null });
  });

  it('a migrated board plans nothing', () => {
    const b = {
      id: 'b',
      color: 'blue',
      icon: '',
      indicator: { kind: 'color', color: '#3b82f6' },
      description: 'plain',
      stages: [stage('s1', 'blue', { indicator: { kind: 'emoji', emoji: '✅' } })],
    };
    expect(planBoard(S, b)).toBeNull();
    // and the plan's output validates
    const first = planBoard(S, { id: 'x', color: 'red', icon: 'bug', description: richText('x') })!;
    expect(S.IndicatorSchema.safeParse(first.indicator).success).toBe(true);
  });
});

describe('planStages', () => {
  it('only stages without one change; all set → null', () => {
    const done = { kind: 'icon', icon: 'flag', color: '#ef4444' };
    const out = planStages(S, [stage('a', 'red', { indicator: done }), stage('b', 'green')])!;
    expect(out[0]?.indicator).toBe(done);
    expect(out[1]?.indicator).toEqual({ kind: 'color', color: '#22c55e' });
    expect(planStages(S, out)).toBeNull();
    expect(planStages(S, undefined)).toBeNull();
  });
});

describe('artifacts, memories, workspaces', () => {
  it('artifact: emoji icon kept; the ◆ glyph / none → a palette colour from the id', () => {
    expect(planArtifact(S, { id: 'a1', icon: '📊' })).toEqual({
      indicator: { kind: 'emoji', emoji: '📊' },
    });
    expect(planArtifact(S, { id: 'a2', icon: null })).toEqual({
      indicator: S.defaultIndicator('a2'),
    });
    expect(planArtifact(S, { id: 'a3', icon: '◆' })).toEqual({
      indicator: S.defaultIndicator('a3'),
    });
    expect(planArtifact(S, { id: 'a4', indicator: { kind: 'emoji', emoji: '📊' } })).toBeNull();
  });

  it('memory: emoji icon kept; none → 🧠', () => {
    expect(planMemory(S, { id: 'm1', icon: '📚' })).toEqual({
      indicator: { kind: 'emoji', emoji: '📚' },
    });
    expect(planMemory(S, { id: 'm2', icon: null })).toEqual({
      indicator: { kind: 'emoji', emoji: '🧠' },
    });
    expect(
      planMemory(S, { id: 'm3', icon: 'x', indicator: { kind: 'emoji', emoji: '🧠' } }),
    ).toBeNull();
  });

  it('workspace: its hex colour', () => {
    expect(planWorkspace(S, { id: 'w1', color: '#14B8A6' })).toEqual({
      indicator: { kind: 'color', color: '#14b8a6' },
    });
    expect(
      planWorkspace(S, {
        id: 'w1',
        color: '#14b8a6',
        indicator: { kind: 'color', color: '#14b8a6' },
      }),
    ).toBeNull();
  });
});
