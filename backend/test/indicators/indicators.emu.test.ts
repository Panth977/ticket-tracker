/**
 * indicators.html — every entity's create / update takes an `indicator` and a
 * plain-text `description`; legacy fields are kept in step; bad marks are 400.
 */
import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX,
  MEMORY_DEFAULT_INDICATOR,
  paths,
  type Artifact,
  type Memory,
  type Stage,
  type Workspace,
} from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { toPublicBoard } from '../../src/platform/public.js';
import { toPublicArtifact } from '../../src/platform/artifacts.js';
import { artifactPath } from '../../src/artifacts/shared.js';
import { setupEmulators } from '../harness/index.js';
import { call, createUser, getBoard, newBoard } from '../boards/helpers.js';

setupEmulators();

const doc = async <T>(path: string) => (await db().doc(path).get()).data() as T;
const ICON = { kind: 'icon', icon: 'rocket', color: '#ef4444' } as const;
const EMOJI = { kind: 'emoji', emoji: '🚀' } as const;
const IMAGE = { kind: 'image', path: 'indicators/u1/abcdef12/logo.png' } as const;

describe('indicators — boards', () => {
  it('create: indicator + description stored; color kept in step; stages get indicators', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice, {
      template: 'kanban',
      indicator: ICON,
      description: '  Platform work: APIs and infra.  ',
    });
    const b = (await getBoard(boardId))!;
    expect(b.indicator).toEqual(ICON);
    expect(b.color).toBe('#ef4444');
    expect(b.description).toBe('Platform work: APIs and infra.');
    for (const s of b.stages) expect(s.indicator).toBeTruthy();
    const pub = toPublicBoard({ ...b, id: boardId });
    expect(pub.indicator).toEqual(ICON);
    expect(pub.description_md).toBe('Platform work: APIs and infra.');
    expect(pub.stages[0]).toMatchObject({ description: null, indicator: expect.any(Object) });
  });

  it('create without one: a palette colour (or the legacy colour / icon)', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const b = (await getBoard(boardId))!;
    expect(b.indicator).toMatchObject({ kind: 'color' });
    expect(b.description).toBeNull();
    const legacy = (await getBoard((await newBoard(alice, { color: 'green' })).boardId))!;
    expect(legacy.indicator).toEqual({ kind: 'color', color: '#22c55e' });
  });

  it('update: indicator, plain description, rich text flattened, null clears', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'boardUpdate', {
      boardId,
      patch: { indicator: EMOJI, description: 'For agents' },
    });
    let b = (await getBoard(boardId))!;
    expect(b.indicator).toEqual(EMOJI);
    expect(b.description).toBe('For agents');

    await call(alice, 'boardUpdate', {
      boardId,
      patch: {
        description: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Ship ' },
                { type: 'text', text: 'fast', marks: [{ type: 'bold' }] },
              ],
            },
          ],
        },
      },
    });
    b = (await getBoard(boardId))!;
    expect(b.description).toBe('Ship **fast**');

    await call(alice, 'boardUpdate', { boardId, patch: { indicator: IMAGE, description: null } });
    b = (await getBoard(boardId))!;
    expect(b.indicator).toEqual(IMAGE);
    expect(b.description).toBeNull();
  });

  it('stages: indicator + description per stage; an old client keeps them', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const b = (await getBoard(boardId))!;
    const [first, ...rest] = b.stages;
    const marked: Stage = {
      ...first!,
      indicator: EMOJI,
      description: 'Not started yet. Move here when triaged.',
    };
    await call(alice, 'boardUpdate', { boardId, patch: { stages: [marked, ...rest] } });
    let s = (await getBoard(boardId))!.stages[0]!;
    expect(s.indicator).toEqual(EMOJI);
    expect(s.description).toBe('Not started yet. Move here when triaged.');

    // An old client: stages without the new fields → kept.
    const stripped = (await getBoard(boardId))!.stages.map(
      ({ indicator: _i, description: _d, ...x }) => x as Stage,
    );
    await call(alice, 'boardUpdate', { boardId, patch: { stages: stripped } });
    s = (await getBoard(boardId))!.stages[0]!;
    expect(s.indicator).toEqual(EMOJI);
    expect(s.description).toBe('Not started yet. Move here when triaged.');

    // An icon indicator keeps the column tint (color) in step; null clears the description.
    const now = (await getBoard(boardId))!.stages;
    await call(alice, 'boardUpdate', {
      boardId,
      patch: { stages: [{ ...now[0]!, indicator: ICON, description: null }, ...now.slice(1)] },
    });
    s = (await getBoard(boardId))!.stages[0]!;
    expect(s).toMatchObject({ indicator: ICON, color: '#ef4444' });
    expect(s.description).toBeUndefined();
  });

  it('bad marks and long descriptions are 400', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const b = (await getBoard(boardId))!;
    const bad: unknown[] = [
      { kind: 'icon', icon: 'not-an-icon', color: '#ef4444' },
      { kind: 'emoji', emoji: 'abc' },
      { kind: 'image', path: 'users/x/avatar/1.webp' },
      { kind: 'color', color: 'blue' },
    ];
    for (const indicator of bad)
      await expect(
        call(alice, 'boardUpdate', { boardId, patch: { indicator } } as never),
      ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(alice, 'boardUpdate', {
        boardId,
        patch: { stages: [{ ...b.stages[0]!, indicator: { kind: 'emoji', emoji: 'x' } }] },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(alice, 'boardUpdate', {
        boardId,
        patch: { description: 'x'.repeat(DESCRIPTION_MAX + 1) },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('indicators — artifacts and memories', () => {
  it('artifact: create / update with indicator + description; legacy icon kept in step', async () => {
    const alice = await createUser();
    const { artifactId } = await call(alice, 'artifactCreate', {
      name: 'Dash',
      description: 'Sales numbers',
      indicator: EMOJI,
    });
    let a = await doc<Artifact>(artifactPath(artifactId));
    expect(a).toMatchObject({ indicator: EMOJI, icon: '🚀', description: 'Sales numbers' });
    expect(toPublicArtifact(artifactId, a, 'owner').indicator).toEqual(EMOJI);

    await call(alice, 'artifactUpdate', { artifactId, indicator: ICON });
    a = await doc<Artifact>(artifactPath(artifactId));
    expect(a).toMatchObject({ indicator: ICON, icon: null });

    // An old client sending only an emoji icon.
    await call(alice, 'artifactUpdate', { artifactId, icon: '📊' });
    a = await doc<Artifact>(artifactPath(artifactId));
    expect(a).toMatchObject({ indicator: { kind: 'emoji', emoji: '📊' }, icon: '📊' });

    const plain = await call(alice, 'artifactCreate', { name: 'Plain' });
    expect((await doc<Artifact>(artifactPath(plain.artifactId))).indicator).toMatchObject({
      kind: 'color',
    });
    await expect(
      call(alice, 'artifactUpdate', {
        artifactId,
        indicator: { kind: 'emoji', emoji: 'hi' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('memory: create / update; default 🧠; memoryList answers the indicator', async () => {
    const alice = await createUser();
    const plain = await call(alice, 'memoryCreate', { name: 'Notes' });
    expect((await doc<Memory>(paths.memory(plain.memoryId))).indicator).toEqual(
      MEMORY_DEFAULT_INDICATOR,
    );
    const { memoryId } = await call(alice, 'memoryCreate', {
      name: 'Brand',
      description: 'Logos and fonts',
      indicator: IMAGE,
    });
    let m = await doc<Memory>(paths.memory(memoryId));
    expect(m).toMatchObject({ indicator: IMAGE, icon: null, description: 'Logos and fonts' });
    await call(alice, 'memoryUpdate', { memoryId, indicator: ICON, description: 'Brand kit' });
    m = await doc<Memory>(paths.memory(memoryId));
    expect(m).toMatchObject({ indicator: ICON, description: 'Brand kit' });

    const { memories } = await call(alice, 'memoryList', {});
    const out = memories.find((x) => x.id === memoryId)!;
    expect(out.indicator).toEqual(ICON);
    expect(memories.find((x) => x.id === plain.memoryId)!.indicator).toEqual(
      MEMORY_DEFAULT_INDICATOR,
    );
    await expect(
      call(alice, 'memoryUpdate', {
        memoryId,
        indicator: { kind: 'image', path: '../x' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('indicators — workspaces', () => {
  it('create / update with indicator + description; colour in step', async () => {
    const alice = await createUser();
    const { workspaceId } = await call(alice, 'workspaceCreate', {
      name: 'Freelance',
      indicator: ICON,
      description: 'Client work',
    });
    let w = await doc<Workspace>(paths.workspace(alice.uid, workspaceId));
    expect(w).toMatchObject({ indicator: ICON, color: '#ef4444', description: 'Client work' });

    await call(alice, 'workspaceUpdate', { workspaceId, indicator: EMOJI, description: null });
    w = await doc<Workspace>(paths.workspace(alice.uid, workspaceId));
    expect(w.indicator).toEqual(EMOJI);
    expect(w.description).toBeUndefined();
    expect(w.color).toBe('#ef4444');

    const plain = await call(alice, 'workspaceCreate', { name: 'Home' });
    const p = await doc<Workspace>(paths.workspace(alice.uid, plain.workspaceId));
    expect(p.indicator).toEqual({ kind: 'color', color: p.color });

    // An old client recolouring a colour workspace moves the indicator too.
    await call(alice, 'workspaceUpdate', { workspaceId: plain.workspaceId, color: '#22c55e' });
    expect((await doc<Workspace>(paths.workspace(alice.uid, plain.workspaceId))).indicator).toEqual(
      { kind: 'color', color: '#22c55e' },
    );
  });
});
