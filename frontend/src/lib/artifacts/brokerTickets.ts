/**
 * THE BROKER'S tk.* OPERATIONS (docs/plan/artifacts.html §K) — a board's
 * tickets for the artifact, as the signed-in viewer.
 *
 * Two fences, both applied here before anything is read or written:
 *   · the OWNER'S GRANT (artifact.boards): a board that is not in it does not
 *     exist for the artifact, and a 'read' grant never writes;
 *   · the VIEWER: reads are Firestore queries in their session (the rules let
 *     them read only boards they are on), writes are the ticket commands in
 *     their name (can() on the server). A grant never lends anyone access.
 *
 * Like the rest of the broker this is not the security boundary for the
 * VIEWER — they could do all of it in the app — it is what keeps the
 * artifact's code inside what its owner allowed. The artifact has no session
 * of its own and no other way to reach a board.
 *
 * Pure: Firestore and the command client arrive as `TicketBackend`.
 */
import {
  applyTicketPlan,
  boardAggFields,
  boardKeyOfTicketKey,
  can,
  inlineMessages,
  planAggregates,
  planThread,
  readThread,
  toDriverAggregates,
  toDriverMessage,
  markdownToDoc,
  planTicketQuery,
  ticketInputToCommand,
  toDriverBoard,
  toDriverPerson,
  toDriverTicket,
  type AggPeriod,
  type AggStats,
  type ArtifactBoardAccess,
  type BoardMember,
  type BoardWithId,
  type DriverBoard,
  type DriverOp,
  type DriverPerson,
  type RichTextDoc,
  type StoredMessage,
  type TicketInput,
  type TicketQuery,
  type TicketWithId,
  type ThreadQuery,
  type AggregateQuery,
  type AggPlan,
} from '@tm/shared';
import { isPlainObject } from './convert';

type Stop = () => void;
type OnError = (error: unknown) => void;

/** The viewer's Firestore and command client, for tickets. */
export interface TicketBackend {
  /** null when it does not exist or the viewer may not read it. */
  board(boardId: string): Promise<BoardWithId | null>;
  members(boardId: string): Promise<BoardMember[]>;
  /** Firestore answers state (+ stage); the broker filters, sorts and cuts the rest. */
  list(
    boardId: string,
    state: 'active' | 'archived',
    stageId: string | null,
  ): Promise<TicketWithId[]>;
  onList(
    boardId: string,
    state: 'active' | 'archived',
    stageId: string | null,
    next: (tickets: TicketWithId[]) => void,
    error: OnError,
  ): Stop;
  byKey(boardId: string, key: string): Promise<TicketWithId | null>;
  create(input: {
    boardId: string;
    title: string;
    description?: RichTextDoc;
    stageId?: string;
    priorityId?: string | null;
    tagIds?: string[];
    assigneeUids?: string[];
    startAt?: number | null;
    dueAt?: number | null;
    fields?: Record<string, unknown>;
  }): Promise<{ ticketId: string; key: string }>;
  update(boardId: string, ticketId: string, patch: Record<string, unknown>): Promise<void>;
  comment(boardId: string, ticketId: string, body: RichTextDoc, markdown: string): Promise<void>;
  /** The ticket document, live (the thread's inline window is on it). null = gone or unreadable. */
  onTicket(
    boardId: string,
    ticketId: string,
    next: (ticket: TicketWithId | null) => void,
    error: OnError,
  ): Stop;
  /** data/{n}'s messages — a frozen page of the older thread; null when missing. */
  page(boardId: string, ticketId: string, n: number): Promise<StoredMessage[] | null>;
  /** The board document, live (fields and lifetime counters for onAggregates). */
  onBoard(boardId: string, next: (board: BoardWithId | null) => void, error: OnError): Stop;
  /** aggStats docs of one period with fromKey <= key (<= toKey), by doc id range. */
  aggStats(
    boardId: string,
    period: AggPeriod,
    fromKey: string,
    toKey: string | null,
  ): Promise<AggStats[]>;
  onAggStats(
    boardId: string,
    period: AggPeriod,
    fromKey: string,
    toKey: string | null,
    next: (docs: AggStats[]) => void,
    error: OnError,
  ): Stop;
  /** The file door, as the viewer: a short-lived URL for a Storage path; null when refused. */
  fileAccess(path: string): Promise<{ url: string; expiresAt: number } | null>;
}

export type TicketOp = Extract<DriverOp, `tk.${string}`>;
export const isTicketOp = (op: DriverOp): op is TicketOp => op.startsWith('tk.');

export interface TicketOpsOptions {
  uid: string;
  backend: TicketBackend;
  /** The artifact's live grant: boardId → 'read' | 'write'. */
  grants: () => Readonly<Record<string, ArtifactBoardAccess>>;
  /** Where the app is ('https://…'), for ticket links. */
  origin: string;
  /** The broker's subscribe(): answers { sub } and counts toward the listener cap. */
  subscribe: (reqId: string, start: (next: (v: unknown) => void, error: OnError) => Stop) => void;
  /** Raise a driver error ('permission-denied' | 'invalid-argument' …). */
  fail: (code: 'permission-denied' | 'invalid-argument' | 'not-found', message: string) => never;
  /** The clock, for the default aggregate range. */
  now?: () => number;
}

/** The plan's field as the board has it now (a relabel shows live); the plan's own if it is gone. */
const fieldNow = (board: BoardWithId, plan: AggPlan) =>
  boardAggFields(board).find((f) => f.id === plan.field.id) ?? plan.field;

interface Granted {
  board: BoardWithId;
  access: ArtifactBoardAccess;
}

export function createTicketOps(o: TicketOpsOptions) {
  const { uid, backend: tk, fail } = o;
  const now = o.now ?? Date.now;

  /**
   * data/{NNN} pages, fetched once per host page: a page is frozen when it is
   * written (only an edit inside it ever touches it again), exactly as the
   * app's own thread caches them (lib/ticket/data.ts › pageCache).
   */
  const pages = new Map<string, Promise<StoredMessage[] | null>>();
  const pageOf = (boardId: string, ticketId: string) => (n: number) => {
    const k = `${boardId}/${ticketId}/${n}`;
    let p = pages.get(k);
    if (!p) {
      p = tk.page(boardId, ticketId, n).catch((e: unknown) => {
        pages.delete(k); // a transient failure must be retryable
        throw e;
      });
      pages.set(k, p);
    }
    return p;
  };

  /** The thread rows the plan asks for → DriverMessage[], oldest first. */
  const threadOut = async (
    board: BoardWithId,
    ticket: TicketWithId,
    plan: ReturnType<typeof planThread>,
    people: ReadonlyMap<string, DriverPerson>,
  ) => {
    const rows = await readThread(ticket, plan, pageOf(board.id, ticket.id));
    const fields = boardAggFields(board);
    return rows.map((m) => toDriverMessage(m, people, fields));
  };

  /** Every granted board this viewer can read, in grant order. */
  async function grantedBoards(): Promise<Granted[]> {
    const grants = Object.entries(o.grants());
    const boards = await Promise.all(
      grants.map(([boardId]) => tk.board(boardId).catch(() => null)),
    );
    return grants.flatMap(([, access], i) => {
      const board = boards[i];
      return board && board.archivedAt === null ? [{ board, access }] : [];
    });
  }

  /** A key ('ENG') or id → the granted board, or permission-denied. */
  async function resolve(ref: unknown, write: boolean): Promise<Granted> {
    if (typeof ref !== 'string' || !ref.trim())
      return fail('invalid-argument', 'board must be a board key like ENG');
    const want = ref.trim();
    const grants = o.grants();
    const id = Object.keys(grants).find((b) => b === want);
    let hit: Granted | undefined;
    if (id) {
      const board = await tk.board(id).catch(() => null);
      if (board) hit = { board, access: grants[id]! };
    } else {
      hit = (await grantedBoards()).find((g) => g.board.key === want.toUpperCase());
    }
    if (!hit) return fail('permission-denied', `This artifact has no access to board ${want}`);
    if (write && hit.access !== 'write')
      return fail('permission-denied', `This artifact may only read board ${hit.board.key}`);
    return hit;
  }

  async function ticketAt(key: unknown, write: boolean) {
    const boardKey = typeof key === 'string' ? boardKeyOfTicketKey(key) : null;
    if (!boardKey)
      return fail('invalid-argument', `"${String(key)}" is not a ticket key like ENG-42`);
    const g = await resolve(boardKey, write);
    const norm = String(key).trim().replace(/^#/, '').toUpperCase();
    return { ...g, ticket: await tk.byKey(g.board.id, norm) };
  }

  const peopleOf = (members: BoardMember[]) =>
    new Map<string, DriverPerson>(members.map((m) => [m.uid, toDriverPerson(m)]));

  const plain = (v: unknown, what: string) =>
    v === undefined
      ? undefined
      : isPlainObject(v)
        ? v
        : fail('invalid-argument', `${what} must be an object`);

  async function run(op: TicketOp, reqId: string, a: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'tk.boards': {
        const granted = await grantedBoards();
        return Promise.all(
          granted.map(async ({ board, access }): Promise<DriverBoard> =>
            toDriverBoard(
              board,
              access,
              can({ actor: uid }, board, 'edit'),
              await tk.members(board.id),
            ),
          ),
        );
      }
      case 'tk.list': {
        const { board } = await resolve(a.board, false);
        const members = await tk.members(board.id);
        const plan = planTicketQuery(
          board,
          members,
          plain(a.query, 'query') as TicketQuery | undefined,
          uid,
        );
        const ts = applyTicketPlan(await tk.list(board.id, plan.state, plan.stageId), plan);
        const people = peopleOf(members);
        return ts.map((t) => toDriverTicket(board, t, people, o.origin));
      }
      case 'tk.onList': {
        const { board } = await resolve(a.board, false);
        const members = await tk.members(board.id);
        const plan = planTicketQuery(
          board,
          members,
          plain(a.query, 'query') as TicketQuery | undefined,
          uid,
        );
        const people = peopleOf(members);
        o.subscribe(reqId, (next, error) =>
          tk.onList(
            board.id,
            plan.state,
            plan.stageId,
            (ts) =>
              next(
                applyTicketPlan(ts, plan).map((t) => toDriverTicket(board, t, people, o.origin)),
              ),
            error,
          ),
        );
        return undefined;
      }
      case 'tk.get': {
        const { board, ticket } = await ticketAt(a.key, false);
        if (!ticket) return null;
        return toDriverTicket(board, ticket, peopleOf(await tk.members(board.id)), o.origin);
      }
      case 'tk.create': {
        const { board } = await resolve(a.board, true);
        const input = plain(a.ticket, 'ticket') ?? fail('invalid-argument', 'ticket is required');
        if (typeof (input as Partial<TicketInput>).title !== 'string')
          return fail('invalid-argument', 'ticket.title is required');
        const members = await tk.members(board.id);
        const f = ticketInputToCommand(board, members, input as Partial<TicketInput>, uid);
        const { description, ...rest } = f;
        const res = await tk.create({
          boardId: board.id,
          title: f.title!,
          ...rest,
          ...(description ? { description } : {}),
        });
        return { id: res.ticketId, key: res.key };
      }
      case 'tk.update': {
        const { board, ticket } = await ticketAt(a.key, true);
        if (!ticket) return fail('not-found', `No ticket ${String(a.key)}`);
        const patch = plain(a.patch, 'patch') ?? fail('invalid-argument', 'patch is required');
        const f = ticketInputToCommand(
          board,
          await tk.members(board.id),
          patch as Partial<TicketInput>,
          uid,
        );
        if (!Object.keys(f).length) return { ok: true };
        await tk.update(board.id, ticket.id, f as Record<string, unknown>);
        return { ok: true };
      }
      case 'tk.comment': {
        const { board, ticket } = await ticketAt(a.key, true);
        if (!ticket) return fail('not-found', `No ticket ${String(a.key)}`);
        if (typeof a.markdown !== 'string' || !a.markdown.trim())
          return fail('invalid-argument', 'comment needs Markdown text');
        const members = await tk.members(board.id);
        const body = markdownToDoc(a.markdown, {
          uidForEmail: (e) =>
            members.find((m) => m.kind !== 'agent' && m.email.toLowerCase() === e)?.uid,
          agentOnBoard: (id) => members.some((m) => m.uid === id),
        });
        await tk.comment(board.id, ticket.id, body, a.markdown);
        return { ok: true };
      }
      case 'tk.thread': {
        const { board, ticket } = await ticketAt(a.key, false);
        if (!ticket) return fail('not-found', `No ticket ${String(a.key)}`);
        const plan = planThread(plain(a.query, 'query') as ThreadQuery | undefined);
        return threadOut(board, ticket, plan, peopleOf(await tk.members(board.id)));
      }
      case 'tk.onThread': {
        const { board, ticket } = await ticketAt(a.key, false);
        if (!ticket) return fail('not-found', `No ticket ${String(a.key)}`);
        const plan = planThread(plain(a.query, 'query') as ThreadQuery | undefined, true);
        const people = peopleOf(await tk.members(board.id));
        o.subscribe(reqId, (next, error) => {
          let seq = 0;
          return tk.onTicket(
            board.id,
            ticket.id,
            (t) => {
              const mine = ++seq;
              if (!t) return error({ code: 'not-found', message: `No ticket ${String(a.key)}` });
              // Older pages may have to be read: only the newest snapshot's answer is sent.
              threadOut(board, t, plan, people).then(
                (out) => mine === seq && next(out),
                (e: unknown) => mine === seq && error(e),
              );
            },
            error,
          );
        });
        return undefined;
      }
      case 'tk.fileUrl': {
        const { ticket } = await ticketAt(a.key, false);
        if (!ticket) return fail('not-found', `No ticket ${String(a.key)}`);
        if (typeof a.file !== 'string' || !a.file)
          return fail('invalid-argument', 'file must be an attachment id');
        // Only a file OF THIS TICKET: its file rows (every message's, spilled
        // pages included), else an attachment of an inline message.
        const path =
          (ticket.files ?? []).find((f) => f.id === a.file && f.deletedAt == null)?.path ??
          inlineMessages(ticket)
            .filter((m) => m.deletedAt == null)
            .flatMap((m) => m.attachments ?? [])
            .find((x) => x.id === a.file)?.path;
        if (!path) return fail('not-found', `No file ${a.file} on ${ticket.key}`);
        const access = await tk.fileAccess(path);
        if (!access) return fail('not-found', 'This file is not available');
        // The file door answers a same-origin path where it cannot sign (dev):
        // the page lives on another origin, so make it absolute.
        const url = o.origin ? new URL(access.url, o.origin).href : access.url;
        return { url, expiresAt: access.expiresAt };
      }
      case 'tk.aggregates': {
        const { board } = await resolve(a.board, false);
        const plan = planAggregates(board, plain(a.query, 'query') as AggregateQuery, now());
        const docs = await tk.aggStats(board.id, plan.field.period, plan.from, plan.to);
        return toDriverAggregates(board, plan, docs);
      }
      case 'tk.onAggregates': {
        const { board } = await resolve(a.board, false);
        const query = plain(a.query, 'query') as AggregateQuery | undefined;
        const plan = planAggregates(board, query, now());
        o.subscribe(reqId, (next, error) => {
          // The buckets, and the board for the field and its lifetime counter.
          let latest: BoardWithId = board;
          let docs: AggStats[] | null = null;
          const emit = () => {
            if (!docs) return;
            try {
              next(toDriverAggregates(latest, { ...plan, field: fieldNow(latest, plan) }, docs));
            } catch (e) {
              error(e);
            }
          };
          const offBoard = tk.onBoard(
            board.id,
            (b) => {
              if (!b)
                return error({
                  code: 'permission-denied',
                  message: `This artifact has no access to board ${board.key}`,
                });
              latest = { ...b, id: board.id };
              emit();
            },
            error,
          );
          const offStats = tk.onAggStats(
            board.id,
            plan.field.period,
            plan.from,
            plan.to,
            (d) => {
              docs = d;
              emit();
            },
            error,
          );
          return () => {
            offBoard();
            offStats();
          };
        });
        return undefined;
      }
    }
  }

  return { run };
}
