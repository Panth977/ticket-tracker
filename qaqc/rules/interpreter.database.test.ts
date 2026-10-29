/**
 * database.rules.json through IceBase's evaluator (what the IceBase server enforces) vs. the
 * Realtime Database emulator: the same reads and writes, by the same people and agents, must get
 * the same answers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { get, ref, remove, set, update } from 'firebase/database';
import { live, rtdb, statusKey } from '@tm/shared';
import { loadDatabaseRules } from '@panth977/icebase-cli/internal';
import { ADMIN, BOARD, EDITOR, MEMBERS, OTHER_BOARD, STRANGER, TICKET, VIEWER, as, makeEnv, readRules, rt } from './_env.js';

let env: RulesTestEnvironment;
const rules = loadDatabaseRules(readRules('database.rules.json'));
const AGENT = 'ag_0123456789abcdef';
const ART = 'art_1';

type Json = null | boolean | number | string | { [k: string]: Json };
let tree: Json = null;
const segs = (p: string) => p.split('/').filter(Boolean);
function put(root: Json, path: string[], value: Json): Json {
  if (!path.length) return value;
  const o: Record<string, Json> = root !== null && typeof root === 'object' ? { ...root } : {};
  const next = put(o[path[0]!] ?? null, path.slice(1), value);
  if (next === null) delete o[path[0]!];
  else o[path[0]!] = next;
  return Object.keys(o).length ? o : null;
}

const seed: [string, Json][] = [
  ...MEMBERS.map((uid) => [rtdb.boardReader(BOARD, uid), true] as [string, Json]),
  [rtdb.boardReader(OTHER_BOARD, STRANGER), true],
  [rtdb.presence(BOARD, ADMIN), { state: 'online', lastChanged: 1 }],
  [rtdb.typing(BOARD, TICKET, ADMIN), { at: 1 }],
  [live.status(BOARD, AGENT, statusKey(TICKET)), { state: 'working', at: 1, startedAt: 1, ticketId: TICKET }],
  [live.rev(BOARD), 5],
  [live.wake(AGENT), 3],
  [`artifactReaders/${ART}/${ADMIN}`, 'owner'],
  [`artifactReaders/${ART}/${VIEWER}`, 'viewer'],
  [`artifactFlags/${ART}`, { readOnly: true }],
  [`artifactData/${ART}/count`, 1],
];
for (const [p, v] of seed) tree = put(tree, segs(p), v);

type Who = { uid: string; token?: Record<string, unknown> } | null;
const WHO: Who[] = [null, ...MEMBERS.map((uid) => ({ uid })), { uid: STRANGER }, { uid: AGENT, token: { board: BOARD } }, { uid: AGENT, token: { board: OTHER_BOARD } }];
const dbOf = (w: Who) => rt(w ? env.authenticatedContext(w.uid, w.token ?? {}) : env.unauthenticatedContext());
const authOf = (w: Who) => (w ? { uid: w.uid, token: { ...(w.token ?? {}) } } : null);
const label = (w: Who) => (w ? `${w.uid}${w.token?.board ? `@${String(w.token.board)}` : ''}` : 'anon');

async function emu(p: Promise<unknown>): Promise<boolean> {
  try {
    await assertSucceeds(p);
    return true;
  } catch {
    try {
      await assertFails(p);
    } catch {
      /* settled */
    }
    return false;
  }
}

beforeAll(async () => {
  env = await makeEnv({ database: true });
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const [p, v] of seed) await set(ref(rt(ctx), p), v);
  });
});
afterAll(() => env?.cleanup());

describe('database rules evaluator = RTDB emulator', () => {
  it('reads', async () => {
    const paths = [
      `presence/${BOARD}`,
      `presence/${OTHER_BOARD}`,
      `typing/${BOARD}`,
      `status/${BOARD}`,
      `rev/${BOARD}`,
      `agents/${AGENT}/wake`,
      'boardReaders',
      `artifactData/${ART}`,
      'silence',
    ];
    const diffs: string[] = [];
    for (const w of WHO)
      for (const p of paths) {
        const want = await emu(get(ref(dbOf(w), p)));
        const got = rules.canRead(p, authOf(w), tree as never);
        if (want !== got) diffs.push(`${label(w)} read /${p}: emulator ${want}, evaluator ${got}`);
      }
    expect(diffs).toEqual([]);
  });

  it('writes (set / update / remove), valid and invalid', async () => {
    const now = Date.now();
    const cases: ((w: Who) => [string, 'set' | 'update' | 'remove', Json | Record<string, Json>])[] = [
      (w) => [`presence/${BOARD}/${w?.uid ?? 'x'}`, 'set', { state: 'online', lastChanged: now }],
      (w) => [`presence/${BOARD}/${w?.uid ?? 'x'}`, 'set', { state: 'busy', lastChanged: now }],
      (w) => [`presence/${BOARD}/${w?.uid ?? 'x'}`, 'set', { state: 'online', lastChanged: now, extra: 1 }],
      (w) => [`presence/${BOARD}/${w?.uid ?? 'x'}`, 'set', { state: 'online' }],
      (w) => [`presence/${BOARD}/${w?.uid ?? 'x'}`, 'update', { state: 'away', viewing: TICKET, lastChanged: now }],
      () => [`presence/${BOARD}/${ADMIN}`, 'remove', null],
      (w) => [`typing/${BOARD}/${TICKET}/${w?.uid ?? 'x'}`, 'set', { at: now }],
      (w) => [`typing/${BOARD}/${TICKET}/${w?.uid ?? 'x'}`, 'set', { at: now + 3_600_000 }],
      (w) => [`status/${BOARD}/${w?.uid ?? 'x'}/${statusKey(TICKET)}`, 'set', { state: 'idle', at: now, startedAt: now }],
      () => [`status/${BOARD}/${AGENT}/${statusKey(TICKET)}`, 'set', { state: 'nope', at: now, startedAt: now }],
      () => [`rev/${BOARD}`, 'set', 9],
      () => [`artifactData/${ART}/count`, 'set', 2],
      () => [`boardReaders/${BOARD}/hacker`, 'set', true],
    ];
    const diffs: string[] = [];
    for (const w of WHO)
      for (const make of cases) {
        const [p, op, v] = make(w);
        const r = ref(dbOf(w), p);
        const want = await emu(op === 'set' ? set(r, v) : op === 'update' ? update(r, v as object) : remove(r));
        const written = op === 'update' ? Object.keys(v as object).map((k) => [...segs(p), ...segs(k)]) : [segs(p)];
        let next = tree;
        if (op === 'update') for (const [k, x] of Object.entries(v as object)) next = put(next, [...segs(p), ...segs(k)], x as Json);
        else next = put(next, segs(p), op === 'remove' ? null : (v as Json));
        const got = written.every((at) => rules.canWrite(at.join('/'), authOf(w), tree as never, next as never));
        if (want !== got) diffs.push(`${label(w)} ${op} /${p} ${JSON.stringify(v)}: emulator ${want}, evaluator ${got}`);
        if (want) tree = next;
      }
    expect(diffs).toEqual([]);
  });
});
