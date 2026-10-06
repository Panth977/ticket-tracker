/**
 * §K — a ticket's THREAD as an artifact sees it (BackendDriver.tickets.thread
 * / onThread). Pure: stored messages → DriverMessage (names, Markdown,
 * millis), and the paging walk over the ticket's inline window and its
 * frozen data/{NNN} pages — the same order the app's thread reads them in
 * (frontend lib/ticket/data.ts › threadPage): the inline window first, then a
 * page at a time from the newest, only as far back as the request needs.
 *
 * Nothing here decides access: the broker checks the grant and reads in the
 * viewer's session before any of this runs.
 */
import { errors } from '../errors.js';
import { docToMarkdown } from '../logic/richtext/markdown.js';
import type { AggFieldDef } from '../schema/aggregates.js';
import { byCreatedAt, type StoredMessage } from '../schema/message.js';
import type { Question } from '../schema/question.js';
import { inlineMessages, type Ticket } from '../schema/ticket.js';
import type { RichTextDoc } from '../types/index.js';
import {
  THREAD_DEFAULT,
  THREAD_MAX,
  type DriverMessage,
  type DriverPerson,
  type DriverQuestion,
  type ThreadQuery,
} from './driver.js';

export type ThreadPeople = ReadonlyMap<string, DriverPerson>;

const personOr = (people: ThreadPeople, id: string, name: string): DriverPerson =>
  people.get(id) ?? {
    id,
    kind: id.startsWith('ag_') ? 'agent' : 'user',
    name: name || id,
    email: '',
  };

function toDriverQuestion(q: Question, people: ThreadPeople): DriverQuestion {
  const byId = new Map(q.fields.map((f) => [f.id, f]));
  const answer = q.answer;
  return {
    title: q.title,
    status: q.status,
    blocking: q.blocking,
    fields: q.fields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: !!f.required,
      ...(f.options ? { options: f.options.map((o) => o.label) } : {}),
    })),
    answer: answer
      ? {
          values: Object.fromEntries(
            Object.entries(answer.values).map(([id, v]) => {
              const f = byId.get(id);
              const label = (x: unknown) => f?.options?.find((o) => o.id === x)?.label ?? x;
              return [f?.label ?? id, Array.isArray(v) ? v.map(label) : label(v)];
            }),
          ),
          comment: answer.comment ?? null,
          by: personOr(people, answer.by, ''),
          at: answer.at,
        }
      : null,
  };
}

/** One stored message → what the page sees. Tombstones keep their place, emptied. */
export function toDriverMessage(
  m: StoredMessage,
  people: ThreadPeople,
  aggFields: readonly Pick<AggFieldDef, 'id' | 'label' | 'unit'>[],
): DriverMessage {
  const deleted = m.deletedAt != null;
  const author: DriverPerson = m.authorUid
    ? personOr(people, m.authorUid, m.authorName)
    : { id: '', kind: 'user', name: m.authorName, email: '' };
  const out: DriverMessage = {
    id: m.id,
    kind: m.kind,
    author,
    markdown: deleted
      ? ''
      : (m.markdown ??
        (m.body?.doc
          ? docToMarkdown(m.body.doc as RichTextDoc, { personOf: (uid) => people.get(uid) })
          : (m.body?.text ?? ''))),
    createdAt: m.createdAt,
    editedAt: m.editedAt ?? null,
    deleted,
    replyTo: m.replyTo ?? null,
    pinned: m.pinnedAt != null,
    attachments: deleted
      ? []
      : (m.attachments ?? []).map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })),
  };
  if (m.question && !deleted) out.question = toDriverQuestion(m.question, people);
  if (m.agg) {
    const byId = new Map(aggFields.map((f) => [f.id, f]));
    // `at` (when the entries count, if not createdAt) is newer than some stored messages.
    const at = (m.agg as { at?: unknown }).at;
    out.agg = {
      ...(typeof at === 'number' ? { at } : {}),
      entries: m.agg.entries.map((e) => {
        const f = byId.get(e.fieldId);
        return {
          fieldId: e.fieldId,
          label: f?.label ?? e.fieldId,
          unit: f?.unit ?? '',
          value: e.value,
        };
      }),
    };
  }
  if (m.run)
    out.run = {
      n: m.run.n,
      outcome: m.run.outcome,
      costUsd: m.run.costUsd,
      durationMs: m.run.durationMs,
      model: m.run.model ?? null,
    };
  return out;
}

export interface ThreadPlan {
  limit: number;
  before: { id: string } | { at: number } | null;
}

/** A thread query, checked. `live` (onThread) refuses `before`: a live window is always the newest. */
export function planThread(q: ThreadQuery | undefined, live = false): ThreadPlan {
  const query = q ?? {};
  if (typeof query !== 'object') throw errors.invalid('query must be an object');
  const limit = Math.min(
    THREAD_MAX,
    Math.max(1, Math.floor(Number(query.limit ?? THREAD_DEFAULT)) || THREAD_DEFAULT),
  );
  const b = query.before;
  if (b === undefined || b === null) return { limit, before: null };
  if (live) throw errors.invalid('onThread follows the newest messages; page back with thread()');
  if (typeof b === 'number' && Number.isFinite(b)) return { limit, before: { at: b } };
  if (typeof b === 'string' && b.trim()) return { limit, before: { id: b.trim() } };
  throw errors.invalid('before must be a message id or a time in millis');
}

/**
 * The messages the plan asks for, oldest → newest: the inline window, then
 * data pages from the newest back, fetched only while there are not enough.
 * `page(n)` answers data/{n}'s messages (null when it is missing).
 */
export async function readThread(
  ticket: Pick<Ticket, 'recentMessages' | 'pageCount'>,
  plan: ThreadPlan,
  page: (n: number) => Promise<StoredMessage[] | null>,
): Promise<StoredMessage[]> {
  const byId = new Map<string, StoredMessage>();
  for (const m of inlineMessages(ticket)) byId.set(m.id, m);
  let rows = [...byId.values()].sort(byCreatedAt);
  let next = (ticket.pageCount ?? 0) - 1;
  const before = plan.before;
  const eligible = (): StoredMessage[] | null => {
    if (!before) return rows;
    if ('at' in before) return rows.filter((m) => m.createdAt < before.at);
    const i = rows.findIndex((m) => m.id === before.id);
    return i < 0 ? null : rows.slice(0, i);
  };
  for (;;) {
    const got = eligible();
    if ((got && got.length >= plan.limit) || next < 0) {
      if (!got)
        throw errors.not_found(`No message ${(before as { id: string }).id} on this ticket`);
      return got.slice(Math.max(0, got.length - plan.limit));
    }
    const older = (await page(next)) ?? [];
    next--;
    for (const m of older) if (!byId.has(m.id)) byId.set(m.id, m);
    rows = [...byId.values()].sort(byCreatedAt);
  }
}
