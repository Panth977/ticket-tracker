/**
 * storage.rules — ticket attachments, avatars, indicators, exports.
 * Board roles come from Firestore via firestore.get(), so the board is seeded
 * into the Firestore emulator first.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { deleteObject, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { storage as paths, INDICATOR_IMAGE_MAX_BYTES, MAX_AVATAR_BYTES } from '@tm/shared';
import {
  ADMIN,
  BOARD,
  COMMENTER,
  EDITOR,
  MEMBERS,
  ROLES,
  STRANGER,
  TICKET,
  VIEWER,
  as,
  boardDoc,
  fs,
  makeEnv,
  st,
} from './_env.js';

let env: RulesTestEnvironment;

const EXISTING = paths.attachment(BOARD, TICKET, 'att_1', 'screenshot.png');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const pngMeta = { contentType: 'image/png' };

const storageOf = (uid: string | null) => st(uid ? as(env, uid) : env.unauthenticatedContext());
const upload = (
  uid: string | null,
  path: string,
  bytes: Uint8Array = png,
  contentType = 'image/png',
) => uploadBytes(ref(storageOf(uid), path), bytes, { contentType });

beforeAll(async () => {
  env = await makeEnv({ firestore: true, storage: true });
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(fs(ctx), `boards/${BOARD}`), boardDoc(ROLES));
    await uploadBytes(ref(st(ctx), EXISTING), png, pngMeta);
    await uploadBytes(ref(st(ctx), paths.avatar(ADMIN, 1)), png, pngMeta);
    await uploadBytes(ref(st(ctx), paths.indicator(ADMIN, 'ind_seed1', 'mark.png')), png, pngMeta);
    await uploadBytes(ref(st(ctx), paths.export(ADMIN, 'job1')), png, {
      contentType: 'application/zip',
    });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('ticket attachments', () => {
  it('every role on the board reads', async () => {
    for (const uid of MEMBERS) await assertSucceeds(getMetadata(ref(storageOf(uid), EXISTING)));
  });
  it('a stranger and signed-out do not', async () => {
    await assertFails(getMetadata(ref(storageOf(STRANGER), EXISTING)));
    await assertFails(getMetadata(ref(storageOf(null), EXISTING)));
  });
  it('retired for new files (memory.html §J): no role uploads, none overwrites or deletes', async () => {
    for (const uid of [ADMIN, EDITOR, COMMENTER, VIEWER, STRANGER])
      await assertFails(upload(uid, paths.attachment(BOARD, TICKET, `att_${uid}`, 'a.png')));
    await assertFails(upload(null, paths.attachment(BOARD, TICKET, 'att_n', 'a.png')));
    await assertFails(upload(ADMIN, EXISTING));
    await assertFails(deleteObject(ref(storageOf(ADMIN), EXISTING)));
    await assertFails(upload(ADMIN, paths.thumb(BOARD, TICKET, 'att_1')));
  });
  it('nothing directly under boards/ outside the attachment shape', async () => {
    await assertFails(upload(ADMIN, `boards/${BOARD}/loose.png`));
    await assertFails(upload(ADMIN, `boards/${BOARD}/tickets/${TICKET}/loose.png`));
  });
});

describe('avatars', () => {
  it('any signed-in person reads an avatar; signed-out does not', async () => {
    await assertSucceeds(getMetadata(ref(storageOf(STRANGER), paths.avatar(ADMIN, 1))));
    await assertFails(getMetadata(ref(storageOf(null), paths.avatar(ADMIN, 1))));
  });
  it('the owner writes an image under 5 MB, and may delete it', async () => {
    await assertSucceeds(upload(ADMIN, paths.avatar(ADMIN, 2)));
    await assertSucceeds(upload(ADMIN, paths.avatar(ADMIN, 2)));
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), paths.avatar(ADMIN, 2))));
  });
  it('not someone else’s, not a non-image, not 5 MB', async () => {
    await assertFails(upload(EDITOR, paths.avatar(ADMIN, 3)));
    await assertFails(deleteObject(ref(storageOf(EDITOR), paths.avatar(ADMIN, 1))));
    await assertFails(upload(ADMIN, paths.avatar(ADMIN, 4), png, 'application/pdf'));
    await assertFails(
      upload(ADMIN, paths.avatar(ADMIN, 5), new Uint8Array(MAX_AVATAR_BYTES), 'image/png'),
    );
  });
});

describe('indicator images (indicators.html)', () => {
  const ind = (uid: string, fileId: string, name = 'mark.png') =>
    paths.indicator(uid, fileId, name);
  it('any signed-in person reads one; signed-out does not', async () => {
    await assertSucceeds(getMetadata(ref(storageOf(STRANGER), ind(ADMIN, 'ind_seed1'))));
    await assertFails(getMetadata(ref(storageOf(null), ind(ADMIN, 'ind_seed1'))));
  });
  it('the owner uploads an image ≤ 1 MB of an allowed type, once; may delete it', async () => {
    await assertSucceeds(upload(ADMIN, ind(ADMIN, 'ind_png01')));
    await assertSucceeds(upload(ADMIN, ind(ADMIN, 'ind_svg01', 'm.svg'), png, 'image/svg+xml'));
    await assertSucceeds(
      upload(
        ADMIN,
        ind(ADMIN, 'ind_max01'),
        new Uint8Array(INDICATOR_IMAGE_MAX_BYTES),
        'image/webp',
      ),
    );
    await assertFails(upload(ADMIN, ind(ADMIN, 'ind_png01'))); // no overwrite
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), ind(ADMIN, 'ind_png01'))));
  });
  it('not under someone else’s uid, not signed out', async () => {
    await assertFails(upload(EDITOR, ind(ADMIN, 'ind_other1')));
    await assertFails(upload(null, ind(ADMIN, 'ind_anon01')));
    await assertFails(deleteObject(ref(storageOf(EDITOR), ind(ADMIN, 'ind_seed1'))));
  });
  it('not over 1 MB, not a non-image type, not a bad fileId', async () => {
    await assertFails(
      upload(ADMIN, ind(ADMIN, 'ind_big01'), new Uint8Array(INDICATOR_IMAGE_MAX_BYTES + 1)),
    );
    await assertFails(upload(ADMIN, ind(ADMIN, 'ind_txt01', 'a.txt'), png, 'text/plain'));
    await assertFails(upload(ADMIN, ind(ADMIN, 'ind_bmp01', 'a.bmp'), png, 'image/bmp'));
    await assertFails(upload(ADMIN, ind(ADMIN, 'abc'))); // too short
    await assertFails(upload(ADMIN, ind(ADMIN, 'bad.id!')));
  });
});

describe('exports and everything else', () => {
  it('exports are server-only, even for their owner', async () => {
    await assertFails(getMetadata(ref(storageOf(ADMIN), paths.export(ADMIN, 'job1'))));
    await assertFails(upload(ADMIN, paths.export(ADMIN, 'job2'), png, 'application/zip'));
  });
  it('unmatched paths are denied', async () => {
    await assertFails(upload(ADMIN, 'anything/else.png'));
    await assertFails(upload(ADMIN, `users/${ADMIN}/notes.png`));
  });
});
