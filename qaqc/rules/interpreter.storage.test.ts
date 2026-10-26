/**
 * storage.rules through IceBase's rules engine (what the IceBase server enforces) vs. the Storage
 * emulator (which reads Firestore for firestore.get()/exists()). Same questions, same answers.
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
import { loadRules } from '@panth977/icebase-cli/internal';
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
const rules = loadRules(readRules('storage.rules'), 'storage');
const BUCKET = 'demo-taskmanager.appspot.com';
const EXISTING = paths.attachment(BOARD, TICKET, 'att_1', 'screenshot.png');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const docs = new Map<string, Record<string, unknown>>([
  [`boards/${BOARD}`, JSON.parse(JSON.stringify(boardDoc(ROLES)))],
]);
const objects = new Map<string, { size: number; contentType: string }>();

const DOCS = '/databases/(default)/documents';
const objectResource = (
  name: string,
  o: { size: number; contentType: string; metadata?: Record<string, string> } | undefined,
) => (o ? { name, bucket: BUCKET, size: o.size, contentType: o.contentType, metadata: o.metadata ?? {} } : null);

const interp = (
  uid: string | null,
  method: string,
  name: string,
  after?: { size: number; contentType: string },
) =>
  rules.allows({
    method: method as 'get',
    path: `/b/${BUCKET}/o/${name}`,
    auth: uid ? { uid, token: { email: emailOf(uid), email_verified: true } } : null,
    resource: objectResource(name, objects.get(name)),
    requestResource: after ? objectResource(name, after) : null,
    get: (p: string) => {
      const path = p.replace(/^\/databases\/[^/]+\/documents\//, '');
      const data = docs.get(path);
      return data ? { data, id: path.split('/').pop()!, path: `${DOCS}/${path}` } : null;
    },
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

describe('storage rules: IceBase = Storage emulator', () => {
  it('reads and writes across people and paths', async () => {
    const WHO = [null, ...MEMBERS, STRANGER];
    const diffs: string[] = [];
    for (const uid of WHO) {
      for (const name of [EXISTING, paths.avatar(ADMIN, 1)]) {
        const want = await emu(getMetadata(ref(storageOf(uid), name)));
        const got = await interp(uid, 'get', name);
        if (want !== got)
          diffs.push(`${uid ?? 'anon'} get ${name}: emulator ${want}, IceBase ${got}`);
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
            `${uid ?? 'anon'} write ${name} ${contentType}: emulator ${want}, IceBase ${got}`,
          );
        if (want) objects.set(name, { size: bytes.length, contentType });
      }
    }
    for (const uid of [ADMIN, EDITOR, VIEWER]) {
      const name = paths.avatar(ADMIN, 1);
      if (!objects.has(name)) continue;
      const want = await emu(deleteObject(ref(storageOf(uid), name)));
      const got = await interp(uid, 'delete', name);
      if (want !== got) diffs.push(`${uid} delete ${name}: emulator ${want}, IceBase ${got}`);
      if (want) objects.delete(name);
    }
    expect(diffs).toEqual([]);
  });
});
