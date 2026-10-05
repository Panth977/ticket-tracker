/**
 * A tiny client for the running local stack (emulators + functions `api`),
 * shared by the seed script and the e2e suites:
 *
 *   - people: real Auth-emulator accounts, ID tokens minted over REST
 *   - call(): POST /api/{command} exactly as the SPA does
 *   - admin(): Admin SDK (Firestore / Auth) against the emulators, for reading
 *     what the app has no command for (invite ids, board stage ids, dev outbox)
 *
 * Ports come from firebase.json via scripts/ports.mjs — never hard-coded here.
 */
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { CommandName, CommandReq, CommandRes, PMNode, RichTextDoc } from '@tm/shared';
// @ts-expect-error — plain .mjs shared with the root scripts (no types needed)
import { EMULATOR_ENV, PROJECT_ID, URLS } from '../../scripts/ports.mjs';

const E = EMULATOR_ENV as Record<string, string>;
for (const [k, v] of Object.entries(E)) process.env[k] ||= v;
// No GCE metadata server locally: skip the Admin SDK's credential probe (and its warning).
process.env.METADATA_SERVER_DETECTION ||= 'none';

export const API_URL: string = process.env.TM_API_URL ?? (URLS as { api: string }).api;
export const WEB_URL: string = process.env.TM_WEB_URL ?? (URLS as { web: string }).web;
export { PROJECT_ID };
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST!;

let app: App | undefined;
export function admin(): { db: Firestore; auth: ReturnType<typeof getAuth>; rtdb: Database } {
  app ??=
    getApps()[0] ??
    initializeApp({
      projectId: PROJECT_ID,
      // The namespace the functions use (backend/src/runtime/firebase.ts); the
      // emulator host comes from FIREBASE_DATABASE_EMULATOR_HOST.
      databaseURL: `https://${PROJECT_ID}-default-rtdb.firebaseio.com`,
    });
  return { db: getFirestore(app), auth: getAuth(app), rtdb: getDatabase(app) };
}

export interface Person {
  uid: string;
  email: string;
  name: string;
  password: string;
  token: string;
}

async function authRest<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${path}?key=demo-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`auth ${path}: ${json.error?.message ?? res.status}`);
  return json;
}

export async function signIn(email: string, password: string): Promise<string> {
  const r = await authRest<{ idToken: string }>('accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });
  return r.idToken;
}

/**
 * An account with a verified address (inviteAccept compares verified emails).
 * Reuses the account when it already exists. Waits for onUserCreated to write
 * users/{uid}, which later commands and the Welcome screen rely on.
 */
export async function person(name: string, email: string, password = 'password'): Promise<Person> {
  const { auth, db } = admin();
  let uid: string;
  try {
    uid = (await auth.getUserByEmail(email)).uid;
  } catch {
    uid = (await auth.createUser({ email, password, displayName: name, emailVerified: true })).uid;
  }
  const token = await signIn(email, password);
  await waitFor(`users/${uid}`, async () => (await db.doc(`users/${uid}`).get()).exists, 30_000);
  return { uid, email, name, password, token };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    command: string,
  ) {
    super(`${command} → ${status} ${JSON.stringify(body)}`);
  }
}

/** Any request to the api function; `path` like '/v1/boards'. */
export async function http(
  path: string,
  init: RequestInit = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON of any route; callers assert its shape
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(API_URL + path, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

let seq = 0;
/** POST /api/{command} as `who`, like the SPA (a clientId makes retries idempotent). */
export async function call<N extends CommandName>(
  who: Person,
  command: N,
  input: Omit<CommandReq<N>, 'clientId'> & { clientId?: string },
): Promise<CommandRes<N>> {
  const body = { clientId: `seed${Date.now().toString(36)}${(++seq).toString(36)}`, ...input };
  const r = await http(`/api/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
    body: JSON.stringify(body),
  });
  if (r.status >= 400) throw new ApiError(r.status, r.body, command);
  return r.body as CommandRes<N>;
}

export async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ─── rich text builders ─────────────────────────────────────────────────────

export type Inline = string | { mention: string } | { ref: { ticketId: string; key: string } };

/** One paragraph per argument; each paragraph is a list of inline parts. */
export function doc(...paragraphs: Inline[][]): RichTextDoc {
  return {
    type: 'doc',
    content: paragraphs.map((parts) => ({
      type: 'paragraph',
      content: parts.map(inline).filter((n) => n.type !== 'text' || n.text),
    })),
  };
}
function inline(p: Inline): PMNode {
  if (typeof p === 'string') return { type: 'text', text: p };
  if ('mention' in p) return { type: 'mention', attrs: { uid: p.mention } };
  return { type: 'ticketRef', attrs: { ticketId: p.ref.ticketId, key: p.ref.key } };
}
export const text = (s: string): RichTextDoc => doc([s]);

// ─── board helpers ──────────────────────────────────────────────────────────

export interface BoardInfo {
  id: string;
  key: string;
  stages: { id: string; name: string; category: string }[];
  priorities: { id: string; name: string }[];
  tags: { id: string; name: string }[];
}

export async function board(boardId: string): Promise<BoardInfo> {
  const snap = await admin().db.doc(`boards/${boardId}`).get();
  const b = snap.data() as BoardInfo & Record<string, unknown>;
  return {
    id: boardId,
    key: b.key,
    stages: b.stages,
    priorities: b.priorities,
    tags: b.tags ?? [],
  };
}

export const stage = (b: BoardInfo, name: string) =>
  b.stages.find((s) => s.name === name)?.id ?? fail(`${b.key} has no stage ${name}`);
export const priority = (b: BoardInfo, name: string) =>
  b.priorities.find((p) => p.name === name)?.id ?? fail(`${b.key} has no priority ${name}`);

function fail(msg: string): never {
  throw new Error(msg);
}

/** Invite `invitee` (already signed up) and accept from the inbox (no token). */
export async function inviteAndAccept(
  admin_: Person,
  boardId: string,
  invitee: Person,
  role: 'admin' | 'editor' | 'commenter' | 'viewer',
): Promise<void> {
  await call(admin_, 'inviteCreate', { boardId, invites: [{ email: invitee.email, role }] });
  const q = await admin()
    .db.collection('invites')
    .where('boardId', '==', boardId)
    .where('email', '==', invitee.email)
    .get();
  const pending = q.docs.find((d) => d.get('status') === 'pending') ?? q.docs[0];
  if (!pending) throw new Error(`no invite for ${invitee.email} on ${boardId}`);
  await call(invitee, 'inviteAccept', { inviteId: pending.id, accept: true });
}
