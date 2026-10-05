/**
 * toPublic — THE SHAPE THE OUTSIDE WORLD SEES (platform/backend.json
 * proxyFunctions.toPublic; types in shared/src/api/public.ts).
 *
 * Ids are resolved to names so a script or a model can read a ticket without
 * a second call; custom fields are keyed by NAME outside and by id inside (a
 * rename breaks a script, but it cannot corrupt data). RichText → Markdown:
 * mentions as [@Name](mailto:email), refs as #KEY — which markdownToDoc
 * accepts back unchanged.
 *
 * These are the canonical mappers for REST, MCP and webhook payloads. The
 * list variants take a preloaded `PublicLookups` so a page of 200 tickets
 * costs one members query, not 200.
 */
import {
  deriveAgentHealth,
  fileInfo,
  principalKind,
  questionId,
  questionStatus,
  QuestionStatusSchema,
  tasklistProgress,
  toIso,
  paths,
  type Agent,
  type AgentInboxEvent,
  type AgentStatus,
  type PublicAgent,
  type PublicAgentStatus,
  type PublicCost,
  type PublicRunReceipt,
  type RunReceipt,
  type PublicQuestion,
  type PublicQuestionField,
  type PublicTasklist,
  type Question,
  type QuestionValue,
  type Tasklist,
  type BoardMember,
  type BoardWithId,
  type FieldDef,
  type FieldValue,
  type Message,
  type PublicBoard,
  type PublicMember,
  type PublicMessage,
  type PublicActor,
  type PublicAttachment,
  type PublicEvent,
  type PublicFile,
  type PublicPerson,
  type PublicTicket,
  type TicketFile,
  type TicketWithId,
  type Attachment,
  type InboxItem,
} from '@tm/shared';
import { docToMarkdown } from '@tm/shared/logic/index';
import { db } from '../runtime/firebase.js';
import { locateTickets, type TicketLocation } from '../tickets/locate.js';

export const appUrl = (): string =>
  (process.env.APP_URL ?? 'https://taskmanager.app').replace(/\/$/, '');

/** What the mappers need besides the documents themselves. */
export interface PublicLookups {
  /** uid → member row of THIS board. */
  members: Map<string, BoardMember>;
  /** ticket id → where it is now (links, backlinks, #refs). */
  tickets: Map<string, TicketLocation>;
}

/** Every member of a board, by uid (one query). */
export async function boardMembers(boardId: string): Promise<Map<string, BoardMember>> {
  const snap = await db().collection(paths.members(boardId)).get();
  return new Map(snap.docs.map((d) => [d.id, d.data() as BoardMember]));
}

/** Preload everything a batch of tickets on one board refers to. */
export async function lookupsFor(
  board: BoardWithId,
  tickets: readonly TicketWithId[],
  members?: Map<string, BoardMember>,
): Promise<PublicLookups> {
  const ids = new Set<string>();
  for (const t of tickets) {
    for (const l of t.links) ids.add(l.ticketId);
    for (const r of t.referencedBy) ids.add(r);
    for (const r of t.refs) ids.add(r);
  }
  const [m, located] = await Promise.all([
    members ? Promise.resolve(members) : boardMembers(board.id),
    locateTickets([...ids], board.id),
  ]);
  return { members: m, tickets: located };
}

const personOf = (members: Map<string, BoardMember>) => (uid: string) => {
  const m = members.get(uid);
  return m ? { name: m.name, email: m.email } : undefined;
};

/** A principal (person or agent) on this board as the outside world sees it. */
export function toPublicPerson(members: Map<string, BoardMember>, id: string): PublicPerson {
  const m = members.get(id);
  return {
    id,
    kind: m?.kind ?? principalKind(id),
    name: m?.name ?? id,
    email: m?.email ?? '',
    avatar_url: null,
    icon: m?.icon ?? null,
  };
}

/** Who wrote something (messages, files, events); null id = the system. */
export function toPublicActor(
  members: Map<string, BoardMember>,
  id: string | null,
  fallbackName?: string,
): PublicActor {
  if (!id) return { id: null, kind: null, name: fallbackName ?? 'TaskManager' };
  const m = members.get(id);
  return { id, kind: m?.kind ?? principalKind(id), name: m?.name ?? fallbackName ?? id };
}

/** Phase 17 (§Y2): a cost counter as the API states it; null when nothing was ever spent. */
export const toPublicCost = (
  c: { usd: number; runs: number } | undefined | null,
): PublicCost | null => (c ? { usd: c.usd, runs: c.runs } : null);

/** Phase 17 (§Y1): a stored turn receipt → the snake_case wire shape (and back, see runIn). */
export function toPublicRun(r: RunReceipt): PublicRunReceipt {
  return {
    n: r.n,
    outcome: r.outcome,
    cost_usd: r.costUsd,
    session_usd: r.sessionUsd,
    duration_ms: r.durationMs,
    api_turns: r.apiTurns,
    model: r.model,
    usage: r.usage
      ? {
          input: r.usage.input,
          output: r.usage.output,
          cache_read: r.usage.cacheRead,
          cache_write: r.usage.cacheWrite,
        }
      : null,
  };
}

/** The wire receipt (REST / MCP `run`) → what messagePost stores. */
export function runIn(r: PublicRunReceipt): RunReceipt {
  return {
    n: r.n,
    outcome: r.outcome,
    costUsd: r.cost_usd,
    sessionUsd: r.session_usd,
    durationMs: r.duration_ms,
    apiTurns: r.api_turns,
    model: r.model,
    usage: r.usage
      ? {
          input: r.usage.input,
          output: r.usage.output,
          cacheRead: r.usage.cache_read,
          cacheWrite: r.usage.cache_write,
        }
      : null,
  };
}

/** Phase 17 (§Z2): agents/{agentId} → POST /v1/agents' answer. */
export function toPublicAgent(id: string, a: Agent, avatarUrl: string | null = null): PublicAgent {
  return {
    id,
    kind: 'agent',
    name: a.name,
    description: a.description,
    system_prompt: a.systemPrompt,
    avatar_url: avatarUrl,
    icon: a.icon ?? null,
    archived: a.archivedAt !== null,
    created_at: toIso(a.createdAt)!,
  };
}

/** An attachment as a message lists it (kind decides how to open it; url only when resolved). */
export function toPublicAttachment(a: Attachment, url?: string): PublicAttachment {
  return {
    id: a.id,
    name: a.name,
    mime: a.mime,
    size: a.size,
    kind: fileInfo(a.mime, a.name).kind,
    ...(url ? { url } : {}),
  };
}

/** files/{fileId} → PublicFile (GET /v1/files/{id}, upload answers, ticket detail). */
export function toPublicFile(
  ticketKey: string,
  f: TicketFile,
  members: Map<string, BoardMember>,
  signed?: { url: string; expiresAt: number },
): PublicFile {
  const info = fileInfo(f.mime, f.name);
  return {
    id: f.id,
    name: f.name,
    mime: f.mime,
    size: f.size,
    kind: info.kind,
    ticket_key: ticketKey,
    language: info.language,
    textual: info.textual,
    ...(f.width !== undefined ? { width: f.width } : {}),
    ...(f.height !== undefined ? { height: f.height } : {}),
    ...(signed ? { url: signed.url, url_expires_at: toIso(signed.expiresAt)! } : {}),
    message_id: f.messageId,
    source: f.source,
    ...(f.memory ? { memory: { memory_id: f.memory.memoryId, node_id: f.memory.nodeId } } : {}),
    uploaded_by: toPublicActor(members, f.uploadedBy),
    created_at: toIso(f.createdAt)!,
  };
}

/** A stored field value → what a script reads: option NAMES, people EMAILS, ISO dates. */
export function publicFieldValue(def: FieldDef, v: FieldValue, lk: PublicLookups): unknown {
  if (v === null) return null;
  const optName = (id: string) => def.options?.find((o) => o.id === id)?.name ?? id;
  const person = (uid: string) => lk.members.get(uid)?.email || uid;
  switch (def.type) {
    case 'select':
      return typeof v === 'string' ? optName(v) : v;
    case 'multiSelect':
      return Array.isArray(v) ? v.map(optName) : v;
    case 'person':
      return typeof v === 'string' ? person(v) : v;
    case 'people':
      return Array.isArray(v) ? v.map(person) : v;
    case 'date':
      return typeof v === 'number' ? toIso(v) : v;
    case 'dateRange':
      return typeof v === 'object' && v && 'start' in v
        ? { start: toIso(v.start), end: toIso(v.end) }
        : v;
    case 'ticketRelation':
      return Array.isArray(v) ? v.map((id) => lk.tickets.get(id)?.key ?? id) : v;
    default:
      return v;
  }
}

export function toPublicTicketWith(
  board: BoardWithId,
  t: TicketWithId,
  lk: PublicLookups,
): PublicTicket {
  const stage = board.stages.find((s) => s.id === t.stageId);
  const prio = t.priorityId ? board.priorities.find((p) => p.id === t.priorityId) : undefined;
  const fields: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(t.fields)) {
    const def = board.fields.find((f) => f.id === id);
    if (def && !def.archived) fields[def.name] = publicFieldValue(def, v, lk);
  }
  const keyOf = (id: string) => lk.tickets.get(id)?.key;
  return {
    id: t.id,
    key: t.key,
    url: `${appUrl()}/t/${t.key}`,
    title: t.title,
    description_md: t.description
      ? docToMarkdown(t.description.doc, { personOf: personOf(lk.members), keyOf })
      : null,
    board: { id: board.id, key: board.key, name: board.name },
    stage: {
      id: t.stageId,
      name: stage?.name ?? t.stageId,
      category: stage?.category ?? t.stageCategory,
    },
    priority: prio ? { id: prio.id, name: prio.name } : null,
    tags: t.tagIds.map((id) => board.tags.find((x) => x.id === id)?.name ?? id),
    assignees: t.assigneeUids.map((uid) => toPublicPerson(lk.members, uid)),
    start_at: toIso(t.startAt),
    due_at: toIso(t.dueAt),
    due_all_day: t.dueAllDay,
    estimate: t.estimate,
    fields,
    links: t.links
      .filter((l) => lk.tickets.has(l.ticketId))
      .map((l) => ({ type: l.type, key: lk.tickets.get(l.ticketId)!.key })),
    referenced_by: t.referencedBy.filter((id) => lk.tickets.has(id)).map((id) => keyOf(id)!),
    state: t.state,
    cost: toPublicCost(t.cost),
    created_at: toIso(t.createdAt)!,
    updated_at: toIso(t.updatedAt)!,
  };
}

/** One ticket (loads its own lookups). */
export async function toPublicTicket(board: BoardWithId, t: TicketWithId): Promise<PublicTicket> {
  return toPublicTicketWith(board, t, await lookupsFor(board, [t]));
}

/** A page of tickets on one board. */
export async function toPublicTickets(
  board: BoardWithId,
  ts: readonly TicketWithId[],
): Promise<PublicTicket[]> {
  const lk = await lookupsFor(board, ts);
  return ts.map((t) => toPublicTicketWith(board, t, lk));
}

/**
 * PHASE 3 (§L1) — a question message's form card as the outside world reads
 * it: the fields as asked, who may answer, and, once somebody submits, the
 * values keyed by FIELD ID. `status` is what the card SHOWS, so a question
 * whose expiry has passed already reads 'expired' (questionStatus).
 */
export function toPublicQuestion(
  ticket: { id: string; key: string },
  messageId: string,
  m: Pick<Message, 'authorUid' | 'authorName' | 'createdAt'>,
  q: Question,
  members: Map<string, BoardMember>,
  now: number,
  keyOf: (ticketId: string) => string | undefined = () => undefined,
): PublicQuestion {
  return {
    id: questionId(ticket.id, messageId),
    ticket_key: ticket.key,
    message_id: messageId,
    title: q.title,
    body_md: q.body ? docToMarkdown(q.body.doc, { personOf: personOf(members), keyOf }) : null,
    // A stored QuestionField already IS the public shape (ids, labels, options).
    fields: q.fields.map((f) => ({ ...f }) as PublicQuestionField),
    allow_comment: q.allowComment,
    to: q.to === null ? null : q.to.map((id) => toPublicPerson(members, id)),
    blocking: q.blocking,
    status: questionStatus(q, now),
    expires_at: toIso(q.expiresAt),
    asked_by: toPublicActor(members, m.authorUid, m.authorName),
    created_at: toIso(m.createdAt)!,
    answer: q.answer
      ? {
          values: q.answer.values as Record<string, QuestionValue>,
          comment: q.answer.comment ?? null,
          by: toPublicActor(members, q.answer.by),
          at: toIso(q.answer.at)!,
        }
      : null,
  };
}

/** PHASE 3 (§L2) — a task list document → PUT/PATCH/GET …/tasklists answers. */
export function toPublicTasklist(
  ticketKey: string,
  id: string,
  l: Tasklist,
  members: Map<string, BoardMember>,
): PublicTasklist {
  const p = tasklistProgress(l);
  return {
    id,
    ticket_key: ticketKey,
    title: l.title,
    owner: toPublicActor(members, l.owner),
    items: l.items.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      note: i.note ?? null,
      updated_at: toIso(i.updatedAt)!,
    })),
    position: l.position,
    // 'done' here is what the bar has behind it: done + skipped out of the total.
    progress: { done: p.settled, total: p.total },
    created_at: toIso(l.createdAt)!,
    updated_at: toIso(l.updatedAt)!,
    closed_at: toIso(l.closedAt),
  };
}

/**
 * PHASE 3 (§L3) — an agentStatus document → POST /v1/heartbeat and
 * GET /v1/agents/status. `health` is deriveAgentHealth at answer time, so a
 * caller never has to re-apply the 75-second rule itself.
 */
export function toPublicAgentStatus(
  s: AgentStatus,
  ticketKey: string | null,
  members: Map<string, BoardMember>,
  now: number,
): PublicAgentStatus {
  return {
    agent: toPublicActor(members, s.agentId),
    ticket_key: ticketKey,
    state: s.state,
    health: deriveAgentHealth(s, now),
    message: s.message,
    progress: s.progress,
    last_beat_at: toIso(s.lastBeatAt)!,
    started_at: toIso(s.startedAt)!,
    ended_at: toIso(s.endedAt),
  };
}

export function toPublicMessageWith(
  ticketKey: string,
  id: string,
  m: Message,
  members: Map<string, BoardMember>,
  keyOf: (ticketId: string) => string | undefined = () => undefined,
  /** Phase 3: with the ticket id, a question message carries its form card. */
  ticketId?: string,
  now: number = Date.now(),
): PublicMessage {
  return {
    id,
    ticket_key: ticketKey,
    kind: m.kind,
    ...(m.question && ticketId
      ? {
          question: toPublicQuestion(
            { id: ticketId, key: ticketKey },
            id,
            m,
            m.question,
            members,
            now,
            keyOf,
          ),
        }
      : {}),
    // The Markdown an agent sent is the most faithful body (GFM tables, code
    // fences …) until someone edits the message in the app.
    body_md: m.deletedAt
      ? ''
      : m.markdown && m.editedAt === null
        ? m.markdown
        : docToMarkdown(m.body.doc, { personOf: personOf(members), keyOf }),
    author: toPublicActor(members, m.kind === 'system' ? null : m.authorUid, m.authorName),
    via: m.via,
    via_token: m.viaToken ?? null,
    reply_to: m.replyTo,
    attachments: m.deletedAt ? [] : m.attachments.map((a) => toPublicAttachment(a)),
    reactions: Object.fromEntries(
      Object.entries(m.reactions)
        .filter(([, u]) => u.length > 0)
        .map(([e, u]) => [e, u.length]),
    ),
    pinned: m.pinnedAt !== null,
    run: m.run ? toPublicRun(m.run) : null,
    created_at: toIso(m.createdAt)!,
    edited_at: toIso(m.editedAt),
    deleted: m.deletedAt !== null,
  };
}

/** A page of messages of one ticket. */
export async function toPublicMessages(
  boardId: string,
  ticketKey: string,
  msgs: readonly { id: string; message: Message }[],
  /** Phase 3: the ticket id, so question messages carry their form card. */
  ticketId?: string,
  now: number = Date.now(),
): Promise<PublicMessage[]> {
  const refs = new Set<string>();
  for (const { message } of msgs) for (const r of message.body.refs) refs.add(r);
  const [members, located] = await Promise.all([
    boardMembers(boardId),
    locateTickets([...refs], boardId),
  ]);
  const keyOf = (id: string) => located.get(id)?.key;
  return msgs.map(({ id, message }) =>
    toPublicMessageWith(ticketKey, id, message, members, keyOf, ticketId, now),
  );
}

/** One message (webhook payloads). */
export async function toPublicMessage(
  boardId: string,
  ticketKey: string,
  id: string,
  m: Message,
  ticketId?: string,
): Promise<PublicMessage> {
  return (await toPublicMessages(boardId, ticketKey, [{ id, message: m }], ticketId))[0]!;
}

export function toPublicMember(
  m: BoardMember,
  board?: Pick<BoardWithId, 'access' | 'stageGrants'>,
): PublicMember {
  const kind = m.kind ?? principalKind(m.uid);
  // The board's access map is the authority on role; the member row is a mirror.
  const role = board?.access[m.uid] ?? m.role;
  const grant = board ? (board.stageGrants[m.uid] ?? null) : m.stageGrant;
  return {
    id: m.uid,
    kind,
    name: m.name,
    email: kind === 'agent' ? '' : m.email,
    avatar_url: null,
    icon: kind === 'agent' ? (m.icon ?? null) : null,
    // §AA2: an agent may be admin — shown as what it is (this used to read 'editor').
    role,
    ...(kind === 'agent' ? { description: m.description ?? null } : {}),
    ...(role === 'commenter'
      ? {
          stage_grant: grant ? { stages: grant.stages, assigned_only: !!grant.assignedOnly } : null,
        }
      : {}),
  };
}

/** An inbox event (agent inbox) → PublicEvent. */
export function toPublicAgentEvent(
  id: string,
  e: AgentInboxEvent,
  board: { id: string; key: string; name: string },
  members: Map<string, BoardMember>,
): PublicEvent {
  return {
    id,
    type: e.type,
    board,
    ticket_id: e.ticketId,
    ticket_key: e.ticketKey,
    message_id: e.messageId ?? null,
    actor: e.actor ? toPublicActor(members, e.actor) : null,
    summary: e.summary,
    // Phase 3 (§L1): question_answered / question_cancelled carry the question
    // and the submitted VALUES, so an agent can act on an answer straight out
    // of get_events without a second call.
    ...(e.question
      ? {
          question: {
            id: e.question.id,
            title: e.question.title,
            status: QuestionStatusSchema.catch('answered').parse(e.question.status),
            ...(e.question.values
              ? { values: e.question.values as Record<string, QuestionValue> }
              : {}),
            ...(e.question.comment !== undefined ? { comment: e.question.comment } : {}),
            ...(e.question.answeredBy
              ? { answered_by: toPublicActor(members, e.question.answeredBy) }
              : {}),
          },
        }
      : {}),
    created_at: toIso(e.createdAt)!,
    acked_at: toIso(e.ackedAt),
  };
}

/** A person's in-app inbox row → PublicEvent (person tokens read their own inbox). */
export function toPublicInboxEvent(
  id: string,
  e: InboxItem,
  board: { id: string; key: string; name: string },
  members: Map<string, BoardMember>,
): PublicEvent | null {
  const type = (
    {
      assigned: 'assigned',
      mentioned: 'mentioned',
      comment: 'comment',
      stage: 'stage',
      updated: 'updated',
      created: 'created',
      state: 'state',
      dueSoon: 'dueSoon',
      overdue: 'overdue',
      invited: 'invited',
      question: 'question',
    } as Record<string, PublicEvent['type']>
  )[e.event];
  if (!type) return null;
  return {
    id,
    type,
    board,
    ticket_id: e.ticketId,
    ticket_key: e.ticketKey,
    message_id: e.messageId ?? null,
    actor: e.actor ? toPublicActor(members, e.actor) : null,
    summary: e.summary,
    created_at: toIso(e.createdAt)!,
    acked_at: toIso(e.readAt),
  };
}

/** A board with its stages, options and fields by name; members when given. */
export function toPublicBoard(
  board: BoardWithId,
  members?: Map<string, BoardMember> | BoardMember[],
): PublicBoard {
  const byPos = <T extends { position: number }>(xs: readonly T[]) =>
    [...xs].sort((a, b) => a.position - b.position);
  const list = members ? (members instanceof Map ? [...members.values()] : members) : undefined;
  return {
    id: board.id,
    key: board.key,
    name: board.name,
    url: `${appUrl()}/b/${board.key}`,
    description_md: board.description ? docToMarkdown(board.description.doc) : null,
    stages: byPos(board.stages).map((s) => ({ id: s.id, name: s.name, category: s.category })),
    priorities: byPos(board.priorities).map((p) => ({ id: p.id, name: p.name })),
    tags: byPos(board.tags).map((t) => ({ id: t.id, name: t.name })),
    fields: byPos(board.fields.filter((f) => !f.archived)).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      required: !!f.required,
      ...(f.options ? { options: byPos(f.options).map((o) => o.name) } : {}),
    })),
    ...(list
      ? { members: list.filter((m) => board.access[m.uid]).map((m) => toPublicMember(m, board)) }
      : {}),
    archived: board.archivedAt !== null,
    cost: toPublicCost(board.cost),
  };
}
