/**
 * Shared e2e helpers: fresh people and boards per test (never the demo seed),
 * the dev mail outbox, and small polling utilities.
 */
import { admin, board, call, person, type BoardInfo, type Person } from '../../seed/client.js';

export * from '../../seed/client.js';

const run = Date.now().toString(36).slice(-4).toUpperCase();
let n = 0;

/** Unique per run and per call: 'ada.k3x1.1@e2e.test'. */
export function uniqueEmail(first: string): string {
  return `${first.toLowerCase()}.${run.toLowerCase()}.${++n}.${Math.random().toString(36).slice(2, 6)}@e2e.test`;
}

/** A board key nobody has claimed yet: letter + 5 base36 chars. */
export function uniqueKey(prefix = 'E'): string {
  const tail = (Date.now().toString(36) + Math.random().toString(36).slice(2))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return (prefix[0]!.toUpperCase() + tail.slice(-5)).slice(0, 6);
}

export async function newPerson(first: string, last = 'Tester'): Promise<Person> {
  return person(`${first} ${last}`, uniqueEmail(first));
}

export async function newBoard(
  owner: Person,
  opts: {
    name?: string;
    template?: 'blank' | 'kanban' | 'bugs' | 'support' | 'sprint';
    key?: string;
  } = {},
): Promise<BoardInfo> {
  const key = opts.key ?? uniqueKey();
  const { boardId } = await call(owner, 'boardCreate', {
    name: opts.name ?? `Board ${key}`,
    key,
    template: opts.template ?? 'kanban',
  });
  return board(boardId);
}

/** Poll until `fn` returns a truthy value (or throw after `timeoutMs`). */
export async function eventually<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    `timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`,
  );
}

export interface DevMail {
  id: string;
  to: string | string[];
  subject: string;
  replyTo?: string;
  text?: string;
  html?: string;
  at: number;
}

/** Mail the dev email adapter "sent" to `email` (newest first). */
export async function mailTo(email: string): Promise<DevMail[]> {
  const snap = await admin()
    .db.collection('_dev/mail/items')
    .orderBy('at', 'desc')
    .limit(200)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<DevMail, 'id'>) }))
    .filter((m) =>
      (Array.isArray(m.to) ? m.to : [m.to]).some((t) =>
        String(t).toLowerCase().includes(email.toLowerCase()),
      ),
    );
}

/** Firestore doc data by path (Admin SDK). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads poke at arbitrary fields
export async function read<T = Record<string, any>>(path: string): Promise<T | undefined> {
  return (await admin().db.doc(path).get()).data() as T | undefined;
}
