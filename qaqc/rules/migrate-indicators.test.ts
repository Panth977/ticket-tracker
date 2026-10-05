/**
 * scripts/lib/indicators.mjs against the firestore emulator: seed boards (with
 * legacy colour names, typed icons, rich-text descriptions, stages),
 * artifacts, memories and workspaces as they were before indicators.html, run
 * the migration dry and then for real, check the shape, then run it again:
 * nothing may change.
 *
 * Not a rules suite — it lives here because this project runs with the
 * emulators up (`pnpm --filter @tm/qaqc test:rules`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, type Firestore } from 'firebase/firestore';
import * as S from '@tm/shared';
import type { Summary } from '../../scripts/lib/indicators.mjs';
import { PROJECT_ID, boardDoc, fs, makeEnv } from './_env.js';

const here = dirname(fileURLToPath(import.meta.url));
const OWNER = 'u_ind_owner';
const B1 = 'board_ind1'; // legacy: colour name, typed lucide icon, rich text, stages
const B2 = 'board_ind2'; // already migrated
const stage = (id: string, color: string, position: number) => ({
  id,
  name: id,
  color,
  category: 'todo',
  position,
});
const rich = {
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bugs we ship' }] }],
  },
  text: 'Bugs we ship',
  mentions: [],
  refs: [],
};

let env: RulesTestEnvironment;

function run(apply: boolean): Summary {
  const r = spawnSync(
    process.execPath,
    [
      '--conditions=@tm/source',
      '--import',
      'tsx',
      resolve(here, '_migrate-indicators-runner.ts'),
      JSON.stringify({ projectId: PROJECT_ID, apply }),
    ],
    { cwd: resolve(here, '..'), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  const last = (r.stdout ?? '').split('\n').find((l) => l.startsWith('SUMMARY '));
  if (r.status !== 0 || !last)
    throw new Error(`migration failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(last.slice('SUMMARY '.length)) as Summary;
}

async function admin<T>(fn: (db: Firestore) => Promise<T>): Promise<T> {
  let out!: T;
  await env.withSecurityRulesDisabled(async (ctx) => {
    out = await fn(fs(ctx));
  });
  return out;
}
const read = (path: string) => admin(async (db) => (await getDoc(doc(db, path))).data());

beforeAll(async () => {
  env = await makeEnv({ firestore: true });
  await env.clearFirestore();
  await admin(async (db) => {
    await setDoc(doc(db, `boards/${B1}`), {
      ...boardDoc({ [OWNER]: 'admin' }, 'Legacy', 'LEG'),
      color: 'blue',
      icon: 'bug',
      description: rich,
      stages: [stage('s_todo1', 'slate', 0), stage('s_done1', '#22C55E', 1)],
    });
    await setDoc(doc(db, `boards/${B2}`), {
      ...boardDoc({ [OWNER]: 'admin' }, 'New', 'NEW'),
      color: '#6366f1',
      icon: '',
      indicator: { kind: 'emoji', emoji: '🚀' },
      description: 'Already plain',
      stages: [
        { ...stage('s_x00001', '#6366f1', 0), indicator: { kind: 'color', color: '#6366f1' } },
      ],
    });
    await setDoc(doc(db, 'artifacts/art_ind1'), { name: 'Dash', icon: '📊' });
    await setDoc(doc(db, 'artifacts/art_ind2'), { name: 'Plain', icon: null });
    await setDoc(doc(db, 'memories/mem_ind1'), { name: 'Notes', icon: null });
    await setDoc(doc(db, 'memories/mem_ind2'), { name: 'Books', icon: '📚' });
    await setDoc(doc(db, `users/${OWNER}/workspaces/ws_ind1`), { name: 'Home', color: '#14B8A6' });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('indicators migration (emulator)', () => {
  it('a dry run plans and writes nothing', async () => {
    const dry = run(false);
    expect(dry).toMatchObject({
      boards: { seen: 2, toChange: 1 },
      artifacts: { seen: 2, toChange: 2 },
      memories: { seen: 2, toChange: 2 },
      workspaces: { seen: 1, toChange: 1 },
      descriptions: 1,
      stages: 2,
      applied: { boards: 0, artifacts: 0, memories: 0, workspaces: 0, failed: [] },
    });
    expect((await read(`boards/${B1}`))?.indicator).toBeUndefined();
    expect((await read('memories/mem_ind1'))?.indicator).toBeUndefined();
  });

  it('--apply writes indicators and plain descriptions', async () => {
    const s = run(true);
    expect(s.applied).toEqual({ boards: 1, artifacts: 2, memories: 2, workspaces: 1, failed: [] });

    const b1 = await read(`boards/${B1}`);
    expect(b1?.indicator).toEqual({ kind: 'icon', icon: 'bug', color: '#3b82f6' });
    expect(b1?.color).toBe('blue'); // legacy kept
    expect(b1?.description).toBe('Bugs we ship');
    expect(b1?.stages.map((x: { indicator: unknown }) => x.indicator)).toEqual([
      { kind: 'color', color: '#64748b' },
      { kind: 'color', color: '#22c55e' },
    ]);
    expect(b1?.stages[0].description).toBeUndefined();
    for (const st of b1!.stages) expect(S.StageSchema.safeParse(st).success).toBe(true);
    expect(S.BoardSchema.shape.description.safeParse(b1?.description).success).toBe(true);

    expect((await read(`boards/${B2}`))?.indicator).toEqual({ kind: 'emoji', emoji: '🚀' });
    expect((await read('artifacts/art_ind1'))?.indicator).toEqual({ kind: 'emoji', emoji: '📊' });
    expect((await read('artifacts/art_ind2'))?.indicator).toEqual(S.defaultIndicator('art_ind2'));
    expect((await read('memories/mem_ind1'))?.indicator).toEqual({ kind: 'emoji', emoji: '🧠' });
    expect((await read('memories/mem_ind2'))?.indicator).toEqual({ kind: 'emoji', emoji: '📚' });
    expect((await read(`users/${OWNER}/workspaces/ws_ind1`))?.indicator).toEqual({
      kind: 'color',
      color: '#14b8a6',
    });
  });

  it('a re-run changes nothing', async () => {
    const again = run(true);
    expect(again).toMatchObject({
      boards: { toChange: 0 },
      artifacts: { toChange: 0 },
      memories: { toChange: 0 },
      workspaces: { toChange: 0 },
      descriptions: 0,
      stages: 0,
      applied: { boards: 0, artifacts: 0, memories: 0, workspaces: 0, failed: [] },
    });
  });
});
