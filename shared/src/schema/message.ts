/**
 * THE THREAD — messages, activity rows and file rows.
 *
 * Phase 15 (docs/plan/agents.html §W) moved all three OFF their own
 * subcollections and INTO the ticket document: a board open is one query of
 * ten documents, and opening a ticket costs nothing more because the card
 * already read it. The shapes below did not change — a message is the same
 * message it was — they only gained an `id` field, because an array element
 * has no document id to carry it.
 *
 *   Message / Activity / TicketFile   the payload, as before
 *   Stored*                           the same thing with its id inline
 *
 * Where each one lives is described on TicketSchema (./ticket.ts).
 */
import { z } from 'zod';
import {
  AttachmentSchema,
  MillisSchema,
  PrincipalIdSchema,
  RichTextSchema,
  ViaSchema,
} from '../types/index.js';
import { QuestionSchema, type Question } from './question.js';
import { MessageAggSchema } from './aggregates.js';

/** An id that used to be a document id — generated, one path segment. */
export const StoredIdSchema = z.string().min(1).max(200);

/** 'agg' (aggregates.html): a message whose point is its `agg` entries. */
export const MESSAGE_KINDS = ['comment', 'system', 'question', 'agg'] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

/** Phase 17 (§Y2): { usd, runs } — the counter a ticket and a board keep. */
export const CostCounterSchema = z.object({
  usd: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
});
export type CostCounter = z.infer<typeof CostCounterSchema>;

export const RUN_OUTCOMES = [
  'review',
  'waiting',
  'blocked',
  'failed',
  'stopped',
  'timeout',
] as const;
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/**
 * Phase 17 (agents.html §Y1): the TURN RECEIPT an orchestrator posts when one
 * run of an agent ends. `costUsd` is THIS turn (the orch subtracts the
 * session's previous total — Claude Code reports cost cumulatively across a
 * resumed session); `sessionUsd` is that running total as reported. The app's
 * composer never sends it; REST / MCP / SDK may, with comments:write.
 */
export const RunReceiptSchema = z.object({
  /** The orchestrator's run counter on this ticket, 1-based. */
  n: z.number().int().positive(),
  outcome: RunOutcomeSchema,
  costUsd: z.number().nonnegative(),
  sessionUsd: z.number().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative(),
  apiTurns: z.number().int().nonnegative().nullable(),
  model: z.string().max(80).nullable(),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
      cacheWrite: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type RunReceipt = z.infer<typeof RunReceiptSchema>;

/** One message in the thread (inline on the ticket, or in a data page). */
export const MessageSchema = z.object({
  /**
   * comment  — what a person or an agent wrote
   * system   — 'Priya moved this to QA'
   * question — phase 3 (§L1): a form card; the payload is in `question`, and
   *            `body` holds the title / context so search and previews read it.
   */
  kind: MessageKindSchema,
  body: RichTextSchema,
  /**
   * Phase 2 (agents.html §H): the Markdown SOURCE when the message was posted
   * as Markdown (REST body_markdown, MCP post_message). The thread renders it
   * as GitHub-flavoured Markdown (tables, images, highlighted code — more than
   * the rich-text schema holds); `body` stays the derived doc for text,
   * mentions, refs and search. null / absent = render `body`. Cleared by an
   * edit in the app editor.
   */
  markdown: z.string().max(100_000).nullable().optional(),
  /** null when via email/intake from an outsider (and for system lines). */
  authorUid: PrincipalIdSchema.nullable(),
  authorName: z.string(),
  via: ViaSchema,
  /**
   * Phase 2: the token's name when a token wrote it — 'Builder (agent) via
   * token orch-eng-builder'. Absent / null for app writes.
   */
  viaToken: z.string().max(80).nullable().optional(),
  /** Quoted message id — one level, not nested threads. */
  replyTo: z.string().nullable(),
  attachments: z.array(AttachmentSchema),
  /** '👍' → uids */
  reactions: z.record(z.string(), z.array(PrincipalIdSchema)),
  pinnedAt: MillisSchema.nullable(),
  pinnedBy: PrincipalIdSchema.nullable(),
  editedAt: MillisSchema.nullable(),
  /** Tombstone: 'This message was deleted'. */
  deletedAt: MillisSchema.nullable(),
  createdAt: MillisSchema,
  /**
   * Phase 3 (§L1): present exactly when kind is 'question' — the form, its
   * status and (once submitted) the answer. questionAnswer / questionCancel
   * rewrite this field in place, so the card locks where it already sits in
   * the thread.
   */
  question: QuestionSchema.nullable().optional(),
  /**
   * Phase 17 (§Y1): present on a turn receipt — a 'comment' whose body says
   * "Turn 3 · review · $1.24 · 12 min" and whose numbers are here. The thread
   * renders it as a receipt row; messagePost adds it to the ticket's, the
   * board's and the day's cost counters in the same write.
   */
  run: RunReceiptSchema.nullable().optional(),
  /**
   * aggregates.html: the entries this message adds to the board's aggregate
   * fields — present on a kind 'agg' message, and on a turn receipt (its cost).
   */
  agg: MessageAggSchema.nullable().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/** A message as it is stored: inside `recentMessages` or a data page. */
export const StoredMessageSchema = MessageSchema.extend({ id: StoredIdSchema });
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

/** A question message, narrowed: `question` is there. */
export type QuestionMessage = Message & { kind: 'question'; question: Question };
export const isQuestionMessage = (m: Pick<Message, 'kind' | 'question'>): m is QuestionMessage =>
  m.kind === 'question' && !!m.question;

export const ACTIVITY_ACTIONS = ['create', 'update', 'state', 'link', 'referenced'] as const;

/** One row of the ticket's history — written in the SAME write as the change. */
export const ActivitySchema = z.object({
  action: z.enum(ACTIVITY_ACTIONS),
  /** Raw ids; the UI resolves names. */
  changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
  /** A principal (person or agent). */
  actor: PrincipalIdSchema.nullable(),
  via: ViaSchema,
  /** Phase 2: the token's name when a token made the change. */
  viaToken: z.string().max(80).nullable().optional(),
  /** Which StageGrant authorised a limited move. */
  viaGrant: z.array(z.string()).optional(),
  createdAt: MillisSchema,
});
export type Activity = z.infer<typeof ActivitySchema>;

export const StoredActivitySchema = ActivitySchema.extend({ id: StoredIdSchema });
export type StoredActivity = z.infer<typeof StoredActivitySchema>;

/** Every file on a ticket, in one place (`ticket.files`). Carries its own id. */
export const TicketFileSchema = AttachmentSchema.extend({
  /**
   * 'upload' (phase 2): put on the ticket through the API (POST /v1/tickets/{KEY}/files,
   * MCP upload_file) and not (yet) posted in a message; messagePost's fileIds
   * then attaches it (source → 'message', messageId set).
   */
  source: z.enum(['description', 'message', 'upload', 'memory']),
  /** Jump to where it was posted. */
  messageId: z.string().nullable(),
  createdAt: MillisSchema,
  /** Its message was deleted. */
  deletedAt: MillisSchema.nullable(),
});
export type TicketFile = z.infer<typeof TicketFileSchema>;

/** Newest last. The order every inline list and every data page is kept in. */
export const byCreatedAt = <T extends { createdAt: number; id: string }>(a: T, b: T): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
