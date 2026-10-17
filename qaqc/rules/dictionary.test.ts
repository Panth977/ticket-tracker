/**
 * DICTIONARY (docs/plan/dictionary.html §C) — the rules: dictionaries/{d}
 * and its content/entries are read by the dictionary's PEOPLE; nobody writes
 * either (the commands do). Being on a board it is granted to gives nothing
 * here: those readers go through dictionaryGet.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { fixtures } from '@tm/shared/schema/fixtures';
import { ADMIN, BOARD, COMMENTER, EDITOR, STRANGER, VIEWER, as, fs, makeEnv } from './_env.js';

const DICT = 'dict_alpha01';
const CAST = { [ADMIN]: 'owner', [EDITOR]: 'editor', [VIEWER]: 'viewer' } as const;

let env: RulesTestEnvironment;
const db = (uid: string | null) => fs(uid ? as(env, uid) : env.unauthenticatedContext());

beforeAll(async () => {
  env = await makeEnv({ firestore: true });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(fs(ctx), `dictionaries/${DICT}`), {
      ...fixtures.dictionaries,
      ownerUid: ADMIN,
      access: CAST,
      memberUids: Object.keys(CAST).sort(),
      // COMMENTER is on BOARD, which it is granted to — still no rules access.
      boards: { [BOARD]: 'read' },
      boardIds: [BOARD],
    });
    await setDoc(doc(fs(ctx), `dictionaries/${DICT}/content/entries`), fixtures.dictionaryContent);
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe('dictionaries/{d}', () => {
  it('its people read the document and the entries', async () => {
    for (const uid of Object.keys(CAST)) {
      await assertSucceeds(getDoc(doc(db(uid), `dictionaries/${DICT}`)));
      await assertSucceeds(getDoc(doc(db(uid), `dictionaries/${DICT}/content/entries`)));
    }
  });
  it('a granted board’s member, a stranger and nobody signed in read nothing', async () => {
    for (const uid of [COMMENTER, STRANGER, null]) {
      await assertFails(getDoc(doc(db(uid), `dictionaries/${DICT}`)));
      await assertFails(getDoc(doc(db(uid), `dictionaries/${DICT}/content/entries`)));
    }
  });
  it('a list only with memberUids array-contains me', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(db(EDITOR), 'dictionaries'),
          where('memberUids', 'array-contains', EDITOR),
        ),
      ),
    );
    await assertFails(getDocs(collection(db(EDITOR), 'dictionaries')));
  });
  it('nobody writes, not even the owner', async () => {
    await assertFails(
      setDoc(doc(db(ADMIN), `dictionaries/${DICT}`), { name: 'x' }, { merge: true }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), `dictionaries/${DICT}/content/entries`), { entries: [] }),
    );
  });
});
