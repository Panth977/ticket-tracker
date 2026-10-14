/**
 * storage.rules through the interpreter vs. the Storage emulator (which
 * reads Firestore for firestore.get()/exists()). Same questions, same answers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { deleteObject, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { storage as paths } from '@tm/shared';
import { parseRules } from '../../backend/src/rules/parse.js';
import { allowed, RulePath, type Resource } from '../../backend/src/rules/evaluate.js';
import {
  ADMIN,
  BOARD,
  EDITOR,
  MEMBERS,
  ROLES,
  STRANGER,
  TICKET,
  VIEWER,
  as,
  boardDoc,
  emailOf,
  fs,
  makeEnv,
  readRules,
  st,
} from './_env.js';

let env: RulesTestEnvironment;
const rules = parseRules(readRules('storage.rules'));
const BUCKET = 'demo-taskmanager.appspot.com';
const EXISTING = paths.attachment(BOARD, TICKET, 'att_1', 'screenshot.png');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const docs = new Map<string, Record<string, unknown>>([
  [`boards/${BOARD}`, JSON.parse(JSON.stringify(boardDoc(ROLES)))],
]);
const objects = new Map<string, { size: number; contentType: string }>();

const firestore = {
  async get(segs: string[]) {
    const path = segs.slice(3).join('/');
    const data = docs.get(path);
    return data ? { data, id: segs[segs.length - 1], __name__: new RulePath(segs) } : null;
  },
};
const objectResource = (
  name: string,
  o: { size: number; contentType: string; metadata?: Record<string, string> } | undefined,
): Resource | null =>
  o
    ? { name, bucket: BUCKET, size: o.size, contentType: o.contentType, metadata: o.metadata ?? {} }
    : null;

const interp = (
  uid: string | null,
  method: string,
  name: string,
  after?: { size: number; contentType: string },
) =>
  allowed(rules, {
    path: `/b/${BUCKET}/o/${name}`,
    method,
    request: {
      auth: uid ? { uid, token: { email: emailOf(uid), email_verified: true } } : null,
      method,
      path: `/b/${BUCKET}/o/${name}`,
      time: { toMillis: () => Date.now() },
      resource: after ? objectResource(name, after) : null,
    },
    resource: objectResource(name, objects.get(name)),
    lookup: { get: async () => null },
    firestore,
  });

const storageOf = (uid: string | null) => st(uid ? as(env, uid) : env.unauthenticatedContext());
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
  env = await makeEnv({ firestore: true, storage: true });
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const [p, d] of docs) await setDoc(doc(fs(ctx), p), d);
    await uploadBytes(ref(st(ctx), EXISTING), png, { contentType: 'image/png' });
    await uploadBytes(ref(st(ctx), paths.avatar(ADMIN, 1)), png, { contentType: 'image/png' });
  });
  objects.set(EXISTING, { size: png.length, contentType: 'image/png' });
  objects.set(paths.avatar(ADMIN, 1), { size: png.length, contentType: 'image/png' });
});
afterAll(() => env?.cleanup());

describe('storage rules interpreter = Storage emulator', () => {
  it('reads and writes across people and paths', async () => {
    const WHO = [null, ...MEMBERS, STRANGER];
    const diffs: string[] = [];
    for (const uid of WHO) {
      for (const name of [EXISTING, paths.avatar(ADMIN, 1)]) {
        const want = await emu(getMetadata(ref(storageOf(uid), name)));
        const got = await interp(uid, 'get', name);
        if (want !== got)
          diffs.push(`${uid ?? 'anon'} get ${name}: emulator ${want}, interpreter ${got}`);
      }
      const writes: [string, string, Uint8Array][] = [
        [paths.avatar(uid ?? 'nobody', 2), 'image/png', png],
        [paths.avatar(ADMIN, 3), 'image/png', png],
        [paths.avatar(uid ?? 'nobody', 4), 'text/html', png],
        [paths.attachment(BOARD, TICKET, 'att_2', 'x.png'), 'image/png', png],
        [paths.indicator(uid ?? 'nobody', 'ind_abc123', 'm.png'), 'image/png', png],
        [paths.indicator(uid ?? 'nobody', 'bad id!', 'm.png'), 'image/png', png],
      ];
      for (const [name, contentType, bytes] of writes) {
        const exists = objects.has(name);
        const want = await emu(uploadBytes(ref(storageOf(uid), name), bytes, { contentType }));
        const got = await interp(uid, exists ? 'update' : 'create', name, {
          size: bytes.length,
          contentType,
        });
        if (want !== got)
          diffs.push(
            `${uid ?? 'anon'} write ${name} ${contentType}: emulator ${want}, interpreter ${got}`,
          );
        if (want) objects.set(name, { size: bytes.length, contentType });
      }
    }
    for (const uid of [ADMIN, EDITOR, VIEWER]) {
      const name = paths.avatar(ADMIN, 1);
      if (!objects.has(name)) continue;
      const want = await emu(deleteObject(ref(storageOf(uid), name)));
      const got = await interp(uid, 'delete', name);
      if (want !== got) diffs.push(`${uid} delete ${name}: emulator ${want}, interpreter ${got}`);
      if (want) objects.delete(name);
    }
    expect(diffs).toEqual([]);
  });
});
