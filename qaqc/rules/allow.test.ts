/**
 * PHASE 16 (docs/plan/agents.html §X) — THE ALLOW LIST, IN THE RULES.
 *
 * "The rules enforce it, not the UI." The list itself lives in `_config/allow`,
 * which no client can read; what the rules see is the MIRROR on each person's
 * own profile, `users/{uid}.allowed`. Three states, and all three matter:
 *
 *   true     everything they have a role for, exactly as before
 *   absent   the same — a profile can only exist through a path that was
 *            already gated, so "nothing decided here" is not a refusal (it is
 *            also what every document written before phase 16 looks like)
 *   false    nothing at all, whatever board they are on — except their OWN
 *            profile, which the "ask for access" screen reads
 *
 * The suite also checks the one thing nobody may ever touch: _config itself.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { ADMIN, BOARD, EDITOR, TICKET, as, boardDoc, emailOf, fs, makeEnv } from './_env.js';

let env: RulesTestEnvironment;

/** A refused account that is nonetheless an EDITOR of the board. */
const REFUSED = EDITOR;
/** An allowed one, with the flag written out. */
const ALLOWED = ADMIN;

const userDoc = (uid: string, allowed?: boolean) => ({
  name: uid,
  email: emailOf(uid),
  avatarPath: null,
  timezone: 'UTC',
  locale: 'en',
  theme: 'system',
  whatsapp: null,
  notify: {
    channels: {},
    quietHours: null,
    digest: 'off',
    dueSoonLeadMinutes: 1440,
    commitmentReminders: true,
  },
  createdAt: 0,
  deletedAt: null,
  ...(allowed === undefined ? {} : { allowed }),
});

beforeAll(async () => {
  env = await makeEnv({ firestore: true });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = fs(ctx);
    await setDoc(doc(db, `boards/${BOARD}`), boardDoc({ [ALLOWED]: 'admin', [REFUSED]: 'editor' }));
    await setDoc(doc(db, `boards/${BOARD}/tickets/${TICKET}`), {
      key: 'ENG-1',
      title: 'A ticket',
      state: 'active',
      assigneeUids: [],
      watcherUids: [],
      createdBy: ALLOWED,
    });
    await setDoc(doc(db, `users/${ALLOWED}`), userDoc(ALLOWED, true));
    await setDoc(doc(db, `users/${REFUSED}`), userDoc(REFUSED, false));
    // The list itself, to prove no client can reach it.
    await setDoc(doc(db, '_config/allow'), { emails: [], updatedAt: 0 });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('an account that is not allowed', () => {
  it('reads nothing — not the board it is on, not its tickets, not another profile', async () => {
    const db = fs(as(env, REFUSED));
    await assertFails(getDoc(doc(db, `boards/${BOARD}`)));
    await assertFails(getDoc(doc(db, `boards/${BOARD}/tickets/${TICKET}`)));
    await assertFails(getDocs(collection(db, `boards/${BOARD}/tickets`)));
    await assertFails(getDoc(doc(db, `users/${ALLOWED}`)));
    await assertFails(
      getDocs(query(collection(db, 'boards'), where('readerUids', 'array-contains', REFUSED))),
    );
  });

  it('writes nothing it would otherwise be allowed to write', async () => {
    const db = fs(as(env, REFUSED));
    await assertFails(
      setDoc(doc(db, `users/${REFUSED}/devices/d1`), {
        fcmToken: 't',
        kind: 'web',
        userAgent: 'vitest',
        lastSeenAt: 1,
      }),
    );
    await assertFails(
      setDoc(doc(db, `users/${REFUSED}/reads/${TICKET}`), { readAt: 1, boardId: BOARD }),
    );
  });

  it('still reads its OWN profile — the "ask for access" screen needs it', async () => {
    await assertSucceeds(getDoc(doc(fs(as(env, REFUSED)), `users/${REFUSED}`)));
  });
});

describe('an account that is allowed', () => {
  it('reads its board, its tickets and other profiles as before', async () => {
    const db = fs(as(env, ALLOWED));
    await assertSucceeds(getDoc(doc(db, `boards/${BOARD}`)));
    await assertSucceeds(getDoc(doc(db, `boards/${BOARD}/tickets/${TICKET}`)));
    await assertSucceeds(getDoc(doc(db, `users/${REFUSED}`)));
  });

  it('writes the three things a client may write', async () => {
    const db = fs(as(env, ALLOWED));
    await assertSucceeds(
      setDoc(doc(db, `users/${ALLOWED}/devices/d1`), {
        fcmToken: 't',
        kind: 'web',
        userAgent: 'vitest',
        lastSeenAt: 1,
      }),
    );
    await assertSucceeds(
      setDoc(doc(db, `users/${ALLOWED}/reads/${TICKET}`), { readAt: 1, boardId: BOARD }),
    );
  });
});

describe('an account with no flag at all (every document from before phase 16)', () => {
  it('is not refused — only an explicit false refuses', async () => {
    const uid = 'u_legacy';
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = fs(ctx);
      await setDoc(doc(db, `users/${uid}`), userDoc(uid)); // no `allowed` key
      await setDoc(
        doc(db, `boards/${BOARD}`),
        boardDoc({ [ALLOWED]: 'admin', [REFUSED]: 'editor', [uid]: 'viewer' }),
      );
    });
    await assertSucceeds(getDoc(doc(fs(as(env, uid)), `boards/${BOARD}`)));
  });

  it('and neither is a brand-new account whose profile has not been written yet', async () => {
    // get() answers null for a missing document; the gate must read that as
    // "nothing decided", not as an error (which would be a refusal).
    await assertSucceeds(getDoc(doc(fs(as(env, 'u_nobody')), `users/u_nobody`)));
  });
});

describe('the list itself', () => {
  it('is server-owned: nobody reads it and nobody writes it', async () => {
    for (const uid of [ALLOWED, REFUSED]) {
      const db = fs(as(env, uid));
      await assertFails(getDoc(doc(db, '_config/allow')));
      await assertFails(setDoc(doc(db, '_config/allow'), { emails: [], updatedAt: 1 }));
    }
  });
});
