/**
 * Seeds for the notify suites: valid documents (from the shared fixtures)
 * written straight to the emulator under unique ids, plus fake adapters that
 * record what they would have sent. Not a test file (leading underscore).
 */
import { fixtures } from '@tm/shared/schema/fixtures';
import {
  defaultChannelMatrix,
  paths,
  type Board,
  type BoardPref,
  type EmailMessage,
  type PushMessage,
  type PushResult,
  type Ticket,
  type TicketWithId,
  type User,
} from '@tm/shared';
import { typedDoc } from '../../src/runtime/index.js';
import { fixedClock, memoryQueue, seqIds, setPorts, uniq } from '../harness/index.js';
import type { FixedClock, MemoryQueue } from '../../src/adapters/index.js';

export const T = Date.UTC(2026, 8, 22, 12, 0, 0); // 12:00 UTC, a Tuesday

export async function seedUser(
  over: Partial<User> & { uid?: string } = {},
): Promise<{ uid: string } & User> {
  const uid = over.uid ?? uniq('u');
  const { uid: _drop, ...rest } = over;
  const user: User = {
    ...fixtures.users,
    name: `User ${uid}`,
    email: `${uid.toLowerCase()}@test.dev`,
    avatarPath: null,
    timezone: 'UTC',
    notify: {
      channels: defaultChannelMatrix(),
      quietHours: null,
      digest: 'off',
      dueSoonLeadMinutes: 1440,
      commitmentReminders: true,
    },
    ...rest,
  };
  await typedDoc('users', paths.user(uid)).set(user);
  return { uid, ...user };
}

export async function seedBoard(
  readers: string[],
  over: Partial<Board> = {},
): Promise<{ id: string } & Board> {
  const id = uniq('b');
  const board: Board = {
    ...fixtures.boards,
    key: 'ENG',
    access: Object.fromEntries(readers.map((u, i) => [u, i === 0 ? 'admin' : 'editor'])),
    stageGrants: {},
    readerUids: readers,
    editorUids: readers,
    createdBy: readers[0]!,
    ...over,
  };
  await typedDoc('boards', paths.board(id)).set(board);
  return { id, ...board };
}

let ticketN = 0;
export async function seedTicket(
  boardId: string,
  over: Partial<Ticket> = {},
): Promise<TicketWithId> {
  const id = uniq('t');
  const n = ++ticketN;
  const t: Ticket = {
    ...fixtures.tickets,
    key: `ENG-${n}`,
    number: n,
    title: `Ticket ${n}`,
    description: null,
    assigneeUids: [],
    watcherUids: [],
    commitments: {},
    dueNotified: {},
    dueAt: null,
    dueAllDay: false,
    links: [],
    refs: [],
    ...over,
  };
  await typedDoc('tickets', paths.ticket(boardId, id)).set(t);
  return { ...t, id, boardId };
}

export async function seedPref(
  boardId: string,
  uid: string,
  over: Partial<BoardPref>,
): Promise<void> {
  const p: BoardPref = {
    mode: 'mine',
    watching: [],
    starred: false,
    lastViewId: 'v_board',
    ...over,
  };
  await typedDoc('prefs', paths.pref(boardId, uid)).set(p);
}

export interface Fakes {
  clock: FixedClock;
  queue: MemoryQueue;
  mail: EmailMessage[];
  push: { tokens: string[]; msg: PushMessage }[];
  wa: {
    kind: 'text' | 'template';
    to: string;
    text?: string;
    template?: string;
    params?: string[];
  }[];
  failEmail(on: boolean): void;
  /** Storage writes (path → content type). */
  files: Map<string, string>;
}

/** Swap every port the notify code touches for in-memory recorders. */
export function useFakes(start = T): Fakes {
  const clock = fixedClock(start);
  const queue = memoryQueue();
  const f: Fakes = {
    clock,
    queue,
    mail: [],
    push: [],
    wa: [],
    failEmail: (on) => void (failMail = on),
    files: new Map(),
  };
  let failMail = false;
  let n = 0;
  setPorts({
    clock,
    queue,
    ids: seqIds(Math.random().toString(36).slice(2, 8)),
    email: {
      async send(m) {
        if (failMail) throw new Error('smtp down');
        f.mail.push(m);
        return { providerId: `mail-${++n}` };
      },
    },
    push: {
      async send(tokens, msg): Promise<PushResult[]> {
        f.push.push({ tokens, msg });
        return tokens.map((token) =>
          token.startsWith('unregistered')
            ? { token, ok: false, unregistered: true, error: 'gone' }
            : { token, ok: true, providerId: `push-${++n}` },
        );
      },
    },
    files: {
      async write(path, _data, contentType) {
        f.files.set(path, contentType);
      },
      async stat() {
        return null;
      },
      async read() {
        return new Uint8Array();
      },
      async copy() {},
      async delete() {},
      async deletePrefix() {},
      async list() {
        return [];
      },
      async signedUploadUrl() {
        return '';
      },
      async signedDownloadUrl() {
        return '';
      },
    },
    whatsapp: {
      async sendText(to, text) {
        f.wa.push({ kind: 'text', to, text });
        return { providerId: `wamid.${++n}` };
      },
      async sendTemplate(to, template, params) {
        f.wa.push({ kind: 'template', to, template, params });
        return { providerId: `wamid.${++n}` };
      },
    },
  });
  return f;
}

export const ctxOf = (
  actor: string,
  now = T,
  via: 'app' | 'email' | 'whatsapp' | 'system' = 'app',
) => ({
  actor,
  via,
  now,
});
