/**
 * Phase 2 — agent profiles and the agent inbox (docs/plan/agents.html §B, §D).
 *
 *   agents/{agentId}                          the profile; only its owner reads or writes it
 *   agentInbox/{agentId}/events/{eventId}     what notify() writes for an agent recipient
 *
 * Agents never sign in to Firebase. They act only through a token that
 * `actsAs` them (ApiKey v2), so neither collection is readable by any agent;
 * the owner reads the profile in the app, the token reads it through
 * GET /v1/me / MCP whoami.
 */
import { z } from 'zod';
import {
  AgentIconIdSchema,
  BoardIdSchema,
  MillisSchema,
  PrincipalIdSchema,
  StoragePathSchema,
  TicketIdSchema,
  UidSchema,
} from '../types/index.js';

export const AGENT_NAME_MAX = 60;
export const AGENT_DESCRIPTION_MAX = 200;
export const AGENT_SYSTEM_PROMPT_MAX = 50_000;

/** agents/{agentId} */
export const AgentSchema = z.object({
  /** The person who made it; only they see or change it. */
  ownerUid: UidSchema,
  name: z.string().trim().min(1).max(AGENT_NAME_MAX),
  /** users/{ownerUid}/agents/{agentId}/avatar/{millis}.webp (storage.agentAvatar). */
  avatarPath: StoragePathSchema.nullable(),
  /**
   * A prebuilt icon (types/agentIcons: a brand mark or a generic glyph), shown
   * on the agent's colour wherever it has no picture: avatarPath > icon >
   * initials. null / absent = none.
   */
  icon: AgentIconIdSchema.nullable().optional(),
  /** Markdown. Handed to the agent's tokens (GET /v1/me, MCP whoami). */
  systemPrompt: z.string().max(AGENT_SYSTEM_PROMPT_MAX),
  /** One line, shown in pickers. */
  description: z.string().max(AGENT_DESCRIPTION_MAX).nullable(),
  createdAt: MillisSchema,
  updatedAt: MillisSchema,
  /** Archived: off every board, its tokens revoked. */
  archivedAt: MillisSchema.nullable(),
});
export type Agent = z.infer<typeof AgentSchema>;
export type AgentWithId = Agent & { id: string };

/**
 * What lands in an agent's inbox (§D). An agent receives events for tickets it
 * is assigned to or watching, and for any message that mentions it; its OWN
 * actions never create events for itself.
 */
export const AGENT_EVENT_TYPES = [
  'assigned',
  'unassigned',
  'mentioned',
  'comment',
  'stage',
  'updated',
  'created',
  /** Phase 3 (§L1): somebody answered a question this agent asked — the values are in `answer`. */
  'question_answered',
  /** Phase 3: the question was cancelled or expired; stop waiting for it. */
  'question_cancelled',
] as const;
export const AgentEventTypeSchema = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

/** agentInbox/{agentId}/events/{eventId} — eventId from agentEventId(), so ids sort by time. */
export const AgentInboxEventSchema = z.object({
  type: AgentEventTypeSchema,
  boardId: BoardIdSchema,
  ticketId: TicketIdSchema,
  /** Denormalised: 'ENG-42' at the time of the event. */
  ticketKey: z.string().min(1),
  /** comment / mentioned: the message to read. */
  messageId: z.string().min(1).nullable().optional(),
  /** Who did it: a person or another agent. null = the system (sweeps). */
  actor: PrincipalIdSchema.nullable(),
  /** 'Priya assigned you ENG-42', 'moved to QA'. */
  summary: z.string().max(500),
  createdAt: MillisSchema,
  /**
   * Phase 3 (§L1): question_answered / question_cancelled carry the question
   * itself — questionId(ticketId, messageId) plus, for an answer, the values
   * the person submitted, so an agent needs no second call to act on it.
   */
  question: z
    .object({
      id: z.string().min(1),
      title: z.string().max(500),
      status: z.string().min(1),
      values: z.record(z.string(), z.unknown()).optional(),
      comment: z.string().optional(),
      answeredBy: UidSchema.optional(),
    })
    .nullable()
    .optional(),
  /** Set by ack (REST POST /v1/events/ack, MCP ack_events, agentInboxAck). */
  ackedAt: MillisSchema.nullable(),
});
export type AgentInboxEvent = z.infer<typeof AgentInboxEventSchema>;

/** Unacked events are kept; acked ones are TTL-deleted after this long (field `ackedAt` + TTL). */
export const AGENT_EVENT_ACKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Event ids that SORT BY TIME, so the id doubles as the feed cursor:
 * base36 millis padded to 9 chars (good until year 5188) + '_' + a unique suffix.
 * `suffix` must be unique per agent per millisecond (e.g. a random 8 chars or the source doc id).
 */
export function agentEventId(createdAt: number, suffix: string): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(suffix)) throw new Error('agentEventId: bad suffix');
  return `${createdAt.toString(36).padStart(9, '0')}_${suffix}`;
}

/** The millis an event id was minted at (the inverse of agentEventId), or null. */
export function agentEventTime(eventId: string): number | null {
  const m = /^([0-9a-z]{9})_/.exec(eventId);
  return m ? parseInt(m[1]!, 36) : null;
}
